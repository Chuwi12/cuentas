import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, mock, test } from "node:test";
import type { Generacion } from "../src/llm.ts";
import type { Memoria, Memory } from "../src/memory.ts";
import type { PromptVars } from "../src/prompts.ts";
import { createApp } from "../src/server.ts";

const TOKEN = "t".repeat(40);
const facts = JSON.parse(readFileSync(new URL("./facts.json", import.meta.url), "utf8"));
const USER = randomUUID();

/** Memoria en RAM con la misma semántica que la real (un análisis por mes, todo filtrado por usuario). */
function fakeMemory() {
  const rows: (Memoria & { user: string; model: string })[] = [];
  const m = {
    rows,
    failSave: false,
    async analisis(user: string, month: string) {
      const r = rows.find((x) => x.user === user && x.tipo === "analisis" && x.month === month);
      return r ? { month, content: r.content, model: r.model, created_at: r.created_at } : null;
    },
    async buscar(user: string, _t: string, k: number) {
      return rows.filter((x) => x.user === user).slice(0, k);
    },
    async guardar(user: string, n: { tipo: "analisis" | "conversacion"; month: string; content: string; model: string }) {
      if (m.failSave) throw new Error("bd caída");
      if (n.tipo === "analisis") {
        const i = rows.findIndex((x) => x.user === user && x.tipo === "analisis" && x.month === n.month);
        if (i >= 0) rows.splice(i, 1);
      }
      const r = { id: randomUUID(), user, tipo: n.tipo, month: n.month, content: n.content, model: n.model, created_at: new Date().toISOString() };
      rows.unshift(r);
      return r;
    },
    async listar(user: string) {
      return rows.filter((x) => x.user === user);
    },
    async borrar(user: string, id: string) {
      const i = rows.findIndex((x) => x.id === id && x.user === user);
      if (i >= 0) rows.splice(i, 1);
      return i >= 0;
    },
    async salud() {
      return true;
    },
  };
  return m satisfies Memory & Record<string, unknown>;
}

type Modo = "ok" | "falla-al-empezar" | "falla-contexto" | "falla-a-mitad" | "espera" | "espera-antes" | "corta-por-longitud";
/**
 * LLM falso. "espera": emite un trozo y se queda parado hasta `liberar()` o hasta que lo abortan (la cadena real lanza; aquí termina sin más).
 * "espera-antes": ni siquiera emite el primer trozo (Ollama evaluando el prompt, aún sin cabeceras).
 */
function fakeLlm() {
  const l = {
    modo: "ok" as Modo,
    trozos: ["  Hola", " mundo"],
    abortados: 0, // veces que se abortó la señal de una generación
    llamadas: [] as PromptVars[],
    empezo: Promise.withResolvers<void>(),
    liberar: () => {},
    async stream(vars: PromptVars, signal: AbortSignal): Promise<Generacion> {
      l.llamadas.push(vars);
      if (l.modo === "falla-al-empezar") throw new Error("ollama caído");
      if (l.modo === "falla-contexto") throw new Error("request (4513 tokens) exceeds the available context size (4096 tokens), try increasing it");
      signal.addEventListener("abort", () => l.abortados++, { once: true });
      const parado = new Promise<void>((resolve) => {
        l.liberar = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      const gen: Generacion = {
        async *[Symbol.asyncIterator]() {
          if (l.modo === "espera-antes") await parado;
          if (signal.aborted) return;
          yield l.trozos[0] ?? "";
          l.empezo.resolve();
          if (l.modo === "falla-a-mitad") throw new Error("ollama murió");
          if (l.modo === "espera") await parado;
          if (signal.aborted) return;
          for (const t of l.trozos.slice(1)) yield t;
          gen.motivo = l.modo === "corta-por-longitud" ? "length" : "stop";
        },
      };
      return gen;
    },
    async salud() {
      return { ollama: true, modelo: true };
    },
  };
  return l;
}

const memory = fakeMemory();
const llm = fakeLlm();
const server = createApp({ token: TOKEN, model: "m-test", numCtx: 4096, memory, llm });
let base = "";
before(async () => {
  mock.method(console, "log", () => {}); // el servidor registra cada generación y cada fallo esperado
  mock.method(console, "error", () => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
const reset = () => {
  memory.rows.length = 0;
  memory.failSave = false;
  Object.assign(llm, { modo: "ok", trozos: ["  Hola", " mundo"], abortados: 0, llamadas: [], empezo: Promise.withResolvers<void>(), liberar: () => {} });
};
const api = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = TOKEN, ...rest } = init;
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(base + path, { ...rest, headers });
};
const bodyAnalisis = (over: object = {}) => JSON.stringify({ user_id: USER, month: "2026-09", facts, ...over });
const bodyPregunta = (over: object = {}) => JSON.stringify({ user_id: USER, question: "¿Cuánto gasto en ocio?", facts, ...over });
const eventos = async (res: Response) => (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; text?: string; message?: string; analisis?: Record<string, string> });
const esperar = async (cond: () => boolean, ms = 3000) => {
  const fin = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fin) assert.fail("condición no cumplida a tiempo");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const error = async (res: Response, status: number, code: string) => {
  assert.equal(res.status, status);
  const j = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(j.error.code, code);
  assert.ok(j.error.message.length > 5);
  return j.error.message;
};

// --- autenticación ---

test("auth: sin token, token de otra longitud, esquema distinto y token casi igual dan 401", async () => {
  for (const headers of [{} as Record<string, string>, { authorization: "Bearer corto" }, { authorization: `Bearer ${TOKEN}x` }, { authorization: `Bearer ${TOKEN.slice(0, -1)}` }, { authorization: `Bearer ${"u".repeat(40)}` }, { authorization: `Basic ${TOKEN}` }, { authorization: TOKEN }, { authorization: "Bearer " }]) {
    await error(await fetch(`${base}/salud`, { headers }), 401, "unauthorized");
  }
  await error(await fetch(`${base}/ruta-que-no-existe`), 401, "unauthorized"); // el 401 va antes que el 404
  await error(await fetch(`${base}/analisis`, { method: "POST", body: bodyAnalisis() }), 401, "unauthorized");
});

test("auth: token correcto", async () => {
  const res = await api("/salud");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ollama: true, modelo: true, db: true });
});

// --- validación ---

test("validación: JSON inválido, cuerpo grande, campos mal formados y rutas desconocidas", async () => {
  reset();
  await error(await api("/analisis", { method: "POST", body: "{no es json" }), 422, "validation");
  await error(await api("/analisis", { method: "POST", body: "[1]" }), 422, "validation");
  await error(await api("/analisis", { method: "POST", body: bodyAnalisis({ user_id: "nope" }) }), 422, "validation");
  await error(await api("/analisis", { method: "POST", body: bodyAnalisis({ month: "2026-13" }) }), 422, "validation");
  await error(await api("/analisis", { method: "POST", body: bodyAnalisis({ month: "2026-08" }) }), 422, "validation"); // facts.month no coincide
  await error(await api("/analisis", { method: "POST", body: bodyAnalisis({ facts: { ...facts, report: null } }) }), 422, "validation");
  for (const today of ["ayer", "2026-02-30", "2026-10-32", "2026-9-2", "2026-10-02T10:00:00Z", 20261002, null]) {
    await error(await api("/analisis", { method: "POST", body: bodyAnalisis({ facts: { ...facts, today } }) }), 422, "validation");
  }
  const { today: _sin, ...sinToday } = facts;
  await error(await api("/analisis", { method: "POST", body: bodyAnalisis({ facts: sinToday }) }), 422, "validation");
  await error(await api("/preguntas", { method: "POST", body: bodyPregunta({ question: "   " }) }), 422, "validation");
  await error(await api("/preguntas", { method: "POST", body: bodyPregunta({ question: "a".repeat(1001) }) }), 422, "validation");
  await error(await api("/preguntas", { method: "POST", body: bodyPregunta({ question: 5 }) }), 422, "validation");
  await error(await api("/analisis?user_id=x&month=2026-09"), 422, "validation");
  await error(await api(`/analisis?user_id=${USER}&month=mal`), 422, "validation");
  await error(await api("/memorias"), 422, "validation");
  await error(await api("/memorias/no-es-uuid?user_id=" + USER, { method: "DELETE" }), 422, "validation");
  await error(await api("/memorias/%zz?user_id=" + USER, { method: "DELETE" }), 422, "validation");
  await error(await api("/nada"), 404, "not_found");
  await error(await api("/salud", { method: "POST" }), 404, "not_found");
  const grande = JSON.stringify({ user_id: USER, month: "2026-09", facts, relleno: "x".repeat(256 * 1024) });
  await error(await api("/analisis", { method: "POST", body: grande }), 413, "validation");
  assert.equal(llm.llamadas.length, 0); // nada de eso llegó al modelo
});

test("el candado no se coge con peticiones inválidas", async () => {
  reset();
  await api("/analisis", { method: "POST", body: "{" });
  const res = await api("/preguntas", { method: "POST", body: bodyPregunta() });
  assert.equal(res.status, 200);
  await res.text();
});

// --- generación ---

test("POST /analisis: stream NDJSON con deltas y done; guarda y GET /analisis lo devuelve", async () => {
  reset();
  const res = await api("/analisis", { method: "POST", body: bodyAnalisis() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/x-ndjson/);
  const evs = await eventos(res);
  assert.deepEqual(evs.slice(0, 2), [{ type: "delta", text: "Hola" }, { type: "delta", text: " mundo" }]); // sin espacios iniciales
  const done = evs.at(-1);
  assert.equal(done?.type, "done");
  assert.equal(done?.analisis?.month, "2026-09");
  assert.equal(done?.analisis?.content, "Hola mundo");
  assert.equal(done?.analisis?.model, "m-test");
  assert.match(done?.analisis?.created_at ?? "", /^\d{4}-\d\d-\d\dT/);
  const get = await api(`/analisis?user_id=${USER}&month=2026-09`);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), done?.analisis);
  assert.match(llm.llamadas[0]?.datos ?? "", /Ingresos: 2\.500,00 €/); // el modelo recibe los facts compactados
  assert.match(llm.llamadas[0]?.tarea ?? "", /Analiza el mes 2026-09/);
  await error(await api(`/analisis?user_id=${USER}&month=2026-08`), 404, "not_found");
  await error(await api(`/analisis?user_id=${randomUUID()}&month=2026-09`), 404, "not_found");
});

test("POST /analisis de otro mes recibe el análisis del mes anterior como recuerdo", async () => {
  reset();
  await (await api("/analisis", { method: "POST", body: bodyAnalisis() })).text();
  const oct = { ...facts, month: "2026-10", month_in_progress: true };
  await (await api("/analisis", { method: "POST", body: bodyAnalisis({ month: "2026-10", facts: oct }) })).text();
  const memoria = llm.llamadas[1]?.memoria ?? "";
  assert.match(memoria, /\[Análisis del mes anterior de 2026-09, guardado el \d{4}-\d\d-\d\d; puede estar desactualizado\]\nHola mundo/);
});

test("POST /analisis repetido reemplaza al del mes; /preguntas guarda 'Pregunta/Respuesta' sin tocar el análisis", async () => {
  reset();
  await (await api("/analisis", { method: "POST", body: bodyAnalisis() })).text();
  await (await api("/analisis", { method: "POST", body: bodyAnalisis() })).text();
  const q = await eventos(await api("/preguntas", { method: "POST", body: bodyPregunta() }));
  assert.deepEqual(q.at(-1), { type: "done" });
  const lista = (await (await api(`/memorias?user_id=${USER}`)).json()) as Memoria[];
  assert.deepEqual(lista.map((m) => m.tipo), ["conversacion", "analisis"]); // la más reciente primero
  assert.equal(lista[0]?.content, "Pregunta: ¿Cuánto gasto en ocio?\nRespuesta: Hola mundo");
  assert.equal(lista[0]?.month, "2026-09");
  assert.equal(llm.llamadas[2]?.tarea.includes("¿Cuánto gasto en ocio?"), true);
});

test("memorias: listar y borrar solo las del propio usuario", async () => {
  reset();
  await (await api("/preguntas", { method: "POST", body: bodyPregunta() })).text();
  const [mem] = (await (await api(`/memorias?user_id=${USER}`)).json()) as Memoria[];
  assert.ok(mem);
  assert.deepEqual(await (await api(`/memorias?user_id=${randomUUID()}`)).json(), []);
  await error(await api(`/memorias/${mem.id}?user_id=${randomUUID()}`, { method: "DELETE" }), 404, "not_found");
  assert.equal((await api(`/memorias/${mem.id}?user_id=${USER}`, { method: "DELETE" })).status, 204);
  await error(await api(`/memorias/${mem.id}?user_id=${USER}`, { method: "DELETE" }), 404, "not_found");
  assert.deepEqual(await (await api(`/memorias?user_id=${USER}`)).json(), []);
});

// --- fallos y candado ---

test("Ollama falla antes de empezar: 503 asesor_unavailable en JSON y el candado queda libre", async () => {
  reset();
  llm.modo = "falla-al-empezar";
  await error(await api("/analisis", { method: "POST", body: bodyAnalisis() }), 503, "asesor_unavailable");
  assert.equal(memory.rows.length, 0);
  llm.modo = "ok";
  assert.equal((await api("/analisis", { method: "POST", body: bodyAnalisis() })).status, 200);
});

test("Ollama falla a mitad: evento error, cierre del stream, nada guardado y candado libre", async () => {
  reset();
  llm.modo = "falla-a-mitad";
  const res = await api("/preguntas", { method: "POST", body: bodyPregunta() });
  assert.equal(res.status, 200);
  const evs = await eventos(res);
  assert.equal(evs[0]?.type, "delta");
  assert.equal(evs.at(-1)?.type, "error");
  assert.match(evs.at(-1)?.message ?? "", /interrumpió/);
  assert.equal(evs.filter((e) => e.type === "done").length, 0);
  assert.equal(memory.rows.length, 0);
  llm.modo = "ok";
  assert.equal((await api("/preguntas", { method: "POST", body: bodyPregunta() })).status, 200);
});

test("fallo al guardar: evento error y candado libre", async () => {
  reset();
  memory.failSave = true;
  const evs = await eventos(await api("/analisis", { method: "POST", body: bodyAnalisis() }));
  assert.equal(evs.at(-1)?.type, "error");
  memory.failSave = false;
  assert.equal((await api("/analisis", { method: "POST", body: bodyAnalisis() })).status, 200);
});

test("dos peticiones a la vez: la segunda recibe 409 y al terminar la primera se libera el candado", async () => {
  reset();
  llm.modo = "espera";
  const primera = await api("/analisis", { method: "POST", body: bodyAnalisis() });
  assert.equal(primera.status, 200);
  await llm.empezo.promise;
  const msg = await error(await api("/preguntas", { method: "POST", body: bodyPregunta() }), 409, "conflict");
  assert.equal(msg, "El asesor está ocupado con otra petición; espera a que termine.");
  assert.equal(llm.llamadas.length, 1);
  llm.liberar();
  assert.equal((await eventos(primera)).at(-1)?.type, "done");
  llm.modo = "ok";
  assert.equal((await api("/preguntas", { method: "POST", body: bodyPregunta() })).status, 200);
});

test("el cliente corta a mitad: se aborta la generación, no se guarda nada y el candado se libera", async () => {
  reset();
  llm.modo = "espera";
  const corte = new AbortController();
  const res = await api("/analisis", { method: "POST", body: bodyAnalisis(), signal: corte.signal });
  const lector = res.body!.getReader();
  assert.match(new TextDecoder().decode((await lector.read()).value), /"Hola"/);
  corte.abort();
  await esperar(() => llm.abortados === 1);
  // mientras el servidor procesa el cierre sigue ocupado, pero acaba liberándose
  llm.modo = "ok";
  let res2: Response;
  const fin = Date.now() + 3000;
  do {
    res2 = await api("/preguntas", { method: "POST", body: bodyPregunta() });
    if (res2.status === 200) break;
    await res2.text();
    await new Promise((r) => setTimeout(r, 10));
  } while (Date.now() < fin);
  assert.equal(res2.status, 200);
  assert.equal((await eventos(res2)).at(-1)?.type, "done");
  // solo existe la conversación de la petición completa: la cortada no dejó ni análisis ni rastro
  assert.deepEqual(memory.rows.map((r) => r.tipo), ["conversacion"]);
  assert.equal(llm.abortados, 1); // y terminar con normalidad no cuenta como abortar
});

test("el cliente corta antes del primer trozo (Ollama aún evaluando el prompt): se aborta la señal, no se guarda y se libera", async () => {
  reset();
  llm.modo = "espera-antes";
  const corte = new AbortController();
  const p = api("/analisis", { method: "POST", body: bodyAnalisis(), signal: corte.signal }).catch(() => null);
  await esperar(() => llm.llamadas.length === 1);
  assert.equal(llm.abortados, 0);
  corte.abort(); // sin cabeceras ni trozos todavía: lo único que llega a la capa de Ollama es la señal
  assert.equal(await p, null);
  await esperar(() => llm.abortados === 1);
  llm.modo = "ok";
  const fin = Date.now() + 3000;
  let status = 0;
  while (status !== 200 && Date.now() < fin) {
    const r = await api("/preguntas", { method: "POST", body: bodyPregunta() });
    status = r.status;
    await r.text();
    if (status !== 200) await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(status, 200);
  assert.equal(memory.rows.filter((r) => r.tipo === "analisis").length, 0);
});

test("mientras la primera petición espera al primer token, la segunda recibe 409", async () => {
  reset();
  llm.modo = "espera-antes";
  const corte = new AbortController();
  const primera = api("/analisis", { method: "POST", body: bodyAnalisis(), signal: corte.signal }).catch(() => null);
  await esperar(() => llm.llamadas.length === 1);
  await error(await api("/preguntas", { method: "POST", body: bodyPregunta() }), 409, "conflict");
  corte.abort();
  await primera;
  await esperar(() => llm.abortados === 1);
});

test("el prompt no cabe en el contexto: 503 asesor_unavailable con un mensaje claro, sin cabeceras de stream", async () => {
  reset();
  llm.modo = "falla-contexto";
  const msg = await error(await api("/analisis", { method: "POST", body: bodyAnalisis() }), 503, "asesor_unavailable");
  assert.match(msg, /no cabe en el contexto.*ASESOR_NUM_CTX/);
  assert.equal(memory.rows.length, 0);
  llm.modo = "ok";
  assert.equal((await api("/preguntas", { method: "POST", body: bodyPregunta() })).status, 200); // y el candado queda libre
});

test("respuesta cortada por longitud (done_reason=length): evento error, nada guardado y candado libre", async () => {
  reset();
  llm.modo = "corta-por-longitud";
  const res = await api("/analisis", { method: "POST", body: bodyAnalisis() });
  assert.equal(res.status, 200);
  const evs = await eventos(res);
  assert.equal(evs.at(-1)?.type, "error");
  assert.equal(evs.at(-1)?.message, "La respuesta se cortó por longitud y no se ha guardado.");
  assert.equal(evs.filter((e) => e.type === "done").length, 0);
  assert.equal(memory.rows.length, 0);
  llm.modo = "ok";
  const ok = await eventos(await api("/analisis", { method: "POST", body: bodyAnalisis() }));
  assert.equal(ok.at(-1)?.type, "done"); // con done_reason=stop sí se guarda
  assert.equal(memory.rows.length, 1);
});

test("lo que se guarda va sin IBAN, URL, correos, teléfonos ni direcciones cripto (la pregunta también)", async () => {
  reset();
  llm.trozos = ["Transfiere el ahorro a ES9121000418450200051332 ", "o entra en https://evil.example/pagar y escribe a a@b.es, llama al 612 345 678."];
  const evs = await eventos(await api("/preguntas", { method: "POST", body: bodyPregunta({ question: "¿Puedo pagar a ES9121000418450200051332?" }) }));
  assert.equal(evs.at(-1)?.type, "done");
  const [guardada] = memory.rows;
  assert.equal(guardada?.content, "Pregunta: ¿Puedo pagar a [dato omitido]?\nRespuesta: Transfiere el ahorro a [dato omitido] o entra en [dato omitido] y escribe a [dato omitido], llama al [dato omitido].");
  // lo que ve el modelo en la pregunta no se toca: es lo que escribió el usuario
  assert.match(llm.llamadas[0]?.tarea ?? "", /ES9121000418450200051332/);
  // y el análisis guardado también va redactado, igual que el 'done' que recibe el cliente
  reset();
  llm.trozos = ["Ingresa en ES9121000418450200051332"];
  const an = await eventos(await api("/analisis", { method: "POST", body: bodyAnalisis() }));
  assert.equal(an.at(-1)?.analisis?.content, "Ingresa en [dato omitido]");
  assert.equal(memory.rows[0]?.content, "Ingresa en [dato omitido]");
});
