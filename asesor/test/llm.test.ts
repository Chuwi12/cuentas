// createLlm contra un "Ollama" HTTP falso: lo que viaja por la red (señal, cuerpo, errores, done_reason).
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createLlm } from "../src/llm.ts";

const vars = { datos: "Ingresos: 2.500,00 €", memoria: "(sin recuerdos)", tarea: "Analiza el mes 2026-09." };
const linea = (o: object) => JSON.stringify({ model: "m", created_at: "2026-10-31T10:00:00Z", ...o }) + "\n";
const final = (done_reason: string) => linea({ message: { role: "assistant", content: "" }, done: true, done_reason, eval_count: 3, prompt_eval_count: 5 });

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

/** Arranca el Ollama falso y devuelve un Llm real apuntando a él. */
async function conOllama(handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void) {
  const peticiones: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    const trozos: Buffer[] = [];
    req.on("data", (c: Buffer) => trozos.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(trozos).toString() || "{}") as Record<string, unknown>;
      peticiones.push(body);
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const cfg = loadConfig({
    ASESOR_TOKEN: "t".repeat(40),
    ASESOR_DATABASE_URL: "postgres://x@127.0.0.1:1/x",
    OLLAMA_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ASESOR_MODEL: "m",
    ASESOR_NUM_CTX: "2048",
    ASESOR_KEEP_ALIVE: "7m",
  });
  return { llm: createLlm(cfg), peticiones };
}
const leer = async (g: AsyncIterable<string>) => {
  let t = "";
  for await (const x of g) t += x;
  return t;
};
const esperar = async (cond: () => boolean, ms = 3000) => {
  const fin = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fin) assert.fail("condición no cumplida a tiempo");
    await new Promise((r) => setTimeout(r, 5));
  }
};

// Ojo: con LangChain, `await llm.stream()` no vuelve hasta que llega el primer trozo, así que se lanza sin esperar antes de abortar.
const generar = (llm: ReturnType<typeof createLlm>, signal: AbortSignal) => (async () => leer(await llm.stream(vars, signal)))();

test("abortar antes de que Ollama mande cabeceras (evaluando el prompt) cierra la conexión con Ollama", { timeout: 10_000 }, async () => {
  let llegada = false;
  let cerrada = false;
  const { llm } = await conOllama((_req, res) => {
    llegada = true;
    res.on("close", () => (cerrada = true)); // nunca escribe: ni cabeceras ni primer token
  });
  const ac = new AbortController();
  const lectura = generar(llm, ac.signal).then(
    () => "terminó",
    (e: Error) => e.name,
  );
  await esperar(() => llegada);
  assert.equal(cerrada, false);
  ac.abort();
  await esperar(() => cerrada); // la conexión se cierra: Ollama puede cancelar la tarea
  assert.match(await lectura, /Abort/); // y la lectura termina con un aborto, no se queda colgada
});

test("el tope de tiempo de la generación también corta la conexión", { timeout: 10_000 }, async () => {
  let cerrada = false;
  const { llm } = await conOllama((_req, res) => void res.on("close", () => (cerrada = true)));
  await generar(llm, AbortSignal.timeout(100)).then(
    () => assert.fail("no debería terminar bien"),
    (e: Error) => assert.match(e.name, /Timeout|Abort/),
  );
  await esperar(() => cerrada);
});

test("cada generación usa su propia señal: abortar una ya terminada no afecta a la siguiente", { timeout: 10_000 }, async () => {
  const { llm } = await conOllama((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(linea({ message: { role: "assistant", content: "Hola" }, done: false }) + final("stop"));
  });
  const a = new AbortController();
  assert.equal(await leer(await llm.stream(vars, a.signal)), "Hola");
  a.abort();
  assert.equal(await leer(await llm.stream(vars, new AbortController().signal)), "Hola");
});

test("la petición a /api/chat lleva truncate:false, think:false, num_ctx, keep_alive y el prompt completo", { timeout: 10_000 }, async () => {
  const { llm, peticiones } = await conOllama((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(linea({ message: { role: "assistant", content: "ok" }, done: false }) + final("stop"));
  });
  await leer(await llm.stream(vars, new AbortController().signal));
  const b = peticiones[0] as { model: string; truncate: boolean; think: boolean; keep_alive: string; stream: boolean; options: Record<string, number>; messages: { role: string; content: string }[] };
  assert.equal(b.model, "m");
  assert.equal(b.truncate, false);
  assert.equal(b.think, false);
  assert.equal(b.stream, true);
  assert.equal(b.keep_alive, "7m");
  assert.equal(b.options.num_ctx, 2048);
  assert.equal(b.options.temperature, 0.3);
  assert.equal(b.options.num_predict, 1024);
  assert.deepEqual(b.messages.map((m) => m.role), ["system", "user"]);
  assert.match(b.messages[0]?.content ?? "", /dato omitido|Eres un asesor financiero/);
  assert.match(b.messages[1]?.content ?? "", /<datos>\nIngresos: 2\.500,00 €\n<\/datos>[\s\S]*Analiza el mes 2026-09\.\n\nRecuerda: usa solo cifras de <datos>/);
});

test("Ollama responde 400 porque el prompt no cabe: el error llega al llamante (antes de cualquier trozo)", { timeout: 10_000 }, async () => {
  const { llm } = await conOllama((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "request (4513 tokens) exceeds the available context size (4096 tokens), try increasing it" }));
  });
  await assert.rejects(async () => leer(await llm.stream(vars, new AbortController().signal)), /exceeds the available context size/);
});

test("done_reason del último trozo: 'length' (respuesta cortada) o 'stop'", { timeout: 10_000 }, async () => {
  for (const motivo of ["length", "stop"]) {
    const { llm } = await conOllama((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(linea({ message: { role: "assistant", content: "Hola " }, done: false }) + linea({ message: { role: "assistant", content: "mundo" }, done: false }) + final(motivo));
    });
    const gen = await llm.stream(vars, new AbortController().signal);
    assert.equal(gen.motivo, undefined); // hasta que no termina no se sabe
    assert.equal(await leer(gen), "Hola mundo");
    assert.equal(gen.motivo, motivo);
    server?.closeAllConnections();
    server?.close();
  }
});
