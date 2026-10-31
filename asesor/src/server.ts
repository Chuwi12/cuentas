// Servidor HTTP del asesor. Solo lo llama el backend Rust (contrato interno de docs/ASESOR.md).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import pg from "pg";
import { loadConfig, type Config } from "./config.ts";
import { redactar } from "./compact.ts";
import { authorized, HttpError, readJson, sendError, sendJson } from "./http.ts";
import { createEmbeddings, createLlm, type Generacion, type Llm } from "./llm.ts";
import { applySchema, createMemory, type Analisis, type Memoria, type Memory } from "./memory.ts";
import { buildVars, tareaAnalisis, tareaPregunta } from "./prompts.ts";
import { parseFacts, parseMonth, parseObject, parseQuestion, parseUuid, previousMonth, type Facts } from "./validate.ts";

export interface Deps {
  token: string;
  model: string;
  numCtx: number;
  memory: Memory;
  llm: Llm;
}

/** Tope de una generación entera: libera el candado aunque Ollama se cuelgue (una Raspberry tarda minutos, no más). */
const GEN_TIMEOUT_MS = 15 * 60_000;

const unavailable = (msg: string) => new HttpError(503, "asesor_unavailable", msg);
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createApp(deps: Deps): Server {
  const { memory, llm } = deps;
  let busy = false; // una generación a la vez: el modelo local no da para más

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req, deps.token)) throw new HttpError(401, "unauthorized", "Falta el token del asesor o no es válido.");
    if (!URL.canParse(req.url ?? "/", "http://asesor")) throw new HttpError(404, "not_found", "Ruta no encontrada.");
    const url = new URL(req.url ?? "/", "http://asesor");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /salud") {
      const [ollama, db] = await Promise.all([llm.salud(), memory.salud()]);
      return sendJson(res, 200, { ...ollama, db });
    }
    if (route === "POST /analisis" || route === "POST /preguntas") return generar(req, res, route === "POST /analisis");

    // El resto de rutas son lecturas/borrados baratos y no usan el candado.
    if (route === "GET /analisis") {
      const a = await memory.analisis(userIdOf(url), parseMonth(url.searchParams.get("month")));
      if (!a) throw new HttpError(404, "not_found", "Todavía no hay un análisis de ese mes.");
      return sendJson(res, 200, a);
    }
    if (route === "GET /memorias") return sendJson(res, 200, await memory.listar(userIdOf(url)));
    const borrar = req.method === "DELETE" ? /^\/memorias\/([^/]+)$/.exec(url.pathname) : null;
    if (borrar) {
      const id = parseUuid(borrar[1], "id");
      if (!(await memory.borrar(userIdOf(url), id))) throw new HttpError(404, "not_found", "No existe esa memoria.");
      res.writeHead(204).end();
      return;
    }
    throw new HttpError(404, "not_found", "Ruta no encontrada.");
  }

  async function generar(req: IncomingMessage, res: ServerResponse, esAnalisis: boolean): Promise<void> {
    const body = parseObject(await readJson(req));
    const userId = parseUuid(body.user_id, "user_id");
    const facts = parseFacts(body.facts);
    const month = esAnalisis ? parseMonth(body.month) : facts.month;
    if (esAnalisis && facts.month !== month) throw new HttpError(422, "validation", "facts.month no coincide con month.");
    const question = esAnalisis ? "" : parseQuestion(body.question);

    if (busy) throw new HttpError(409, "conflict", "El asesor está ocupado con otra petición; espera a que termine.");
    busy = true;
    const cliente = new AbortController();
    let terminado = false;
    // 'close' también salta tras un final normal: solo cuenta si la respuesta no se llegó a completar.
    // Abortar la señal corta la conexión con Ollama (ver el fetch de createLlm), incluso antes del primer token.
    const onClose = () => {
      if (terminado || res.writableFinished) return;
      cliente.abort();
    };
    res.on("close", onClose);
    try {
      await ejecutar(res, { userId, month, facts, question, esAnalisis }, cliente.signal);
    } finally {
      terminado = true;
      busy = false; // pase lo que pase (error, corte del cliente, timeout)
    }
  }

  async function ejecutar(res: ServerResponse, p: { userId: string; month: string; facts: Facts; question: string; esAnalisis: boolean }, clienteGone: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([clienteGone, AbortSignal.timeout(GEN_TIMEOUT_MS)]);
    const t0 = performance.now();

    // 1. Memoria: antes de abrir la respuesta, para poder contestar 503 en JSON si algo falla.
    let previo: Analisis | null = null;
    let similares: Memoria[];
    try {
      if (p.esAnalisis) {
        previo = await memory.analisis(p.userId, previousMonth(p.month));
        const q = `Análisis financiero de ${p.month}. ${textoDeAvisos(p.facts)}`;
        similares = (await memory.buscar(p.userId, q, 5)).filter((m) => !(m.tipo === "analisis" && (m.month === previousMonth(p.month) || m.month === p.month))).slice(0, 3);
      } else {
        similares = await memory.buscar(p.userId, p.question, 4);
      }
    } catch (e) {
      if (clienteGone.aborted) return;
      console.error(`memoria: ${msgOf(e)}`);
      throw unavailable("No se pudo consultar la memoria del asesor; comprueba que Ollama y su base de datos están en marcha.");
    }
    const previoMemoria: Memoria | null = previo && { id: "", tipo: "analisis", month: previousMonth(p.month), content: previo.content, created_at: previo.created_at };
    const tarea = p.esAnalisis ? tareaAnalisis(p.month) : tareaPregunta(p.month, p.question);
    const vars = buildVars(p.facts, previoMemoria, similares, tarea, deps.numCtx);

    // 2. Primer trozo no vacío: hasta tenerlo, un fallo de Ollama aún se puede contestar con 503 en JSON.
    let full = "";
    const trozo = (t: string): string => {
      const limpio = full ? t : t.trimStart();
      full += limpio;
      return limpio;
    };
    let gen: Generacion;
    let iter: AsyncIterator<string>;
    let primero = "";
    try {
      gen = await llm.stream(vars, signal);
      iter = gen[Symbol.asyncIterator]();
      for (;;) {
        const r = await iter.next();
        if (r.done) break;
        primero = trozo(r.value);
        if (primero) break;
      }
    } catch (e) {
      if (clienteGone.aborted) return;
      console.error(`ollama: ${msgOf(e)}`);
      // Con truncate:false Ollama rechaza (400) el prompt que no cabe en num_ctx en vez de recortarlo.
      if (/exceeds the available context size/i.test(msgOf(e))) {
        throw unavailable("La consulta no cabe en el contexto del modelo; reduce el periodo o aumenta ASESOR_NUM_CTX.");
      }
      throw unavailable("No se pudo contactar con el modelo de lenguaje local.");
    }
    if (clienteGone.aborted) return;
    if (!primero) throw unavailable("El modelo no devolvió ninguna respuesta.");

    // 3. A partir de aquí la respuesta ya es 200: los fallos van como evento "error".
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    // Sin control de contrapresión: el lector es el backend en local y la salida está acotada por NUM_PREDICT.
    const emit = (ev: object) => res.write(JSON.stringify(ev) + "\n");
    const ttft = performance.now() - t0;
    let trozos = 1;
    emit({ type: "delta", text: primero });
    try {
      for (let r = await iter.next(); !r.done; r = await iter.next()) {
        const t = trozo(r.value);
        if (t) {
          trozos++;
          emit({ type: "delta", text: t });
        }
      }
      // Abortada, la cadena real lanza; algunos streams (y los falsos de los tests) terminan sin más: en ningún caso se guarda a medias.
      if (clienteGone.aborted) return;
      if (signal.aborted) throw new Error("La generación superó el tiempo máximo");
      if (gen.motivo === "length") {
        console.error("generación: Ollama cortó la respuesta por longitud (done_reason=length)");
        emit({ type: "error", message: "La respuesta se cortó por longitud y no se ha guardado." });
        res.end();
        return;
      }
      // Lo que se guarda y se reinyecta cada mes sin IBAN, URL, correos, teléfonos ni direcciones cripto.
      const content = redactar(full.trimEnd());
      const guardada = await memory.guardar(
        p.userId,
        p.esAnalisis
          ? { tipo: "analisis", month: p.month, content, model: deps.model }
          : { tipo: "conversacion", month: p.month, content: `Pregunta: ${redactar(p.question)}\nRespuesta: ${content}`, model: deps.model },
        clienteGone,
      );
      emit(p.esAnalisis ? { type: "done", analisis: { month: p.month, content: guardada.content, model: deps.model, created_at: guardada.created_at } } : { type: "done" });
      const seg = (performance.now() - t0 - ttft) / 1000;
      console.log(`${p.esAnalisis ? "analisis" : "pregunta"} usuario=${p.userId.slice(0, 8)} ttft=${Math.round(ttft)}ms trozos=${trozos} ritmo=${(trozos / Math.max(seg, 0.001)).toFixed(1)}/s`);
    } catch (e) {
      if (clienteGone.aborted) return;
      console.error(`generación: ${msgOf(e)}`);
      emit({ type: "error", message: "La generación se interrumpió por un error del asesor; vuelve a intentarlo." });
    }
    res.end();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const err = e instanceof HttpError ? e : new HttpError(500, "internal", "Error interno del asesor.");
      if (!(e instanceof HttpError)) console.error(`interno: ${msgOf(e)}`);
      if (res.headersSent) res.destroy();
      else sendError(res, err);
    });
  });
  server.requestTimeout = 30_000; // cuerpo lento = conexión muerta (no afecta a la respuesta en stream)
  return server;
}

/** Los avisos de la app (lenguaje natural) como consulta: se parecen a lo que dicen los análisis previos. */
function textoDeAvisos(facts: Facts): string {
  const insights = (facts.report as { insights?: { message?: unknown }[] }).insights;
  return (Array.isArray(insights) ? insights : []).map((i) => (typeof i?.message === "string" ? i.message : "")).join(" ").slice(0, 600);
}

function userIdOf(url: URL): string {
  return parseUuid(url.searchParams.get("user_id"), "user_id");
}

export async function main(config: Config = loadConfig()): Promise<Server> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, statement_timeout: 15_000 });
  pool.on("error", (e) => console.error(`bd: ${e.message}`)); // conexión ociosa caída: no debe tumbar el proceso
  try {
    await applySchema(pool);
  } catch (e) {
    throw new Error(`No se pudo preparar la base de datos del asesor (${msgOf(e)})`);
  }
  const server = createApp({
    token: config.token,
    model: config.model,
    numCtx: config.numCtx,
    memory: createMemory(pool, createEmbeddings(config)),
    llm: createLlm(config),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  console.log(`asesor escuchando en 127.0.0.1:${config.port} (modelo ${config.model}, contexto ${config.numCtx})`);
  const parar = () => {
    server.close();
    server.closeAllConnections(); // dispara el 'close' de cada respuesta: aborta lo que esté generando
    void pool.end().finally(() => process.exit(0));
  };
  process.once("SIGINT", parar);
  process.once("SIGTERM", parar);
  return server;
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(msgOf(e));
    process.exit(1);
  });
}
