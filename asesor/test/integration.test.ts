// Integración con Postgres+pgvector y Ollama de verdad. Se salta sola si no están disponibles.
// BD desechable: ASESOR_TEST_DATABASE_URL (por defecto la de pruebas del repo, puerto 5436). Usa un usuario aleatorio y lo limpia.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { loadConfig } from "../src/config.ts";
import { createEmbeddings, createLlm } from "../src/llm.ts";
import { applySchema, createMemory } from "../src/memory.ts";
import { createApp } from "../src/server.ts";

const DB_URL = process.env.ASESOR_TEST_DATABASE_URL ?? "postgres://asesor:asesor_dev@127.0.0.1:5436/asesor";
const config = loadConfig({ ASESOR_TOKEN: "i".repeat(40), ASESOR_DATABASE_URL: DB_URL, ASESOR_NUM_CTX: process.env.ASESOR_NUM_CTX });
const facts = JSON.parse(readFileSync(new URL("./facts.json", import.meta.url), "utf8"));

const pool = new pg.Pool({ connectionString: DB_URL, max: 3, connectionTimeoutMillis: 2000 });
pool.on("error", () => {});
const llm = createLlm(config);

async function motivoParaSaltar(): Promise<string | false> {
  try {
    await pool.query("SELECT 1");
  } catch {
    return `no hay Postgres en ${new URL(DB_URL).host}`;
  }
  const s = await llm.salud();
  if (!s.ollama) return "Ollama no responde";
  if (!s.modelo) return `faltan los modelos ${config.model} / ${config.embedModel} en Ollama`;
  return false;
}
const skip = await motivoParaSaltar();

const USER = randomUUID();
const OTRO = randomUUID();
const memory = createMemory(pool, createEmbeddings(config));
const server = createApp({ token: config.token, model: config.model, numCtx: config.numCtx, memory, llm });
let base = "";

before(async () => {
  if (skip) return;
  await applySchema(pool);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  if (!skip) await pool.query("DELETE FROM memorias WHERE user_id = ANY($1)", [[USER, OTRO]]);
  await pool.end();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" } });
const eventos = async (res: Response) => (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; text?: string; message?: string; analisis?: { month: string; content: string; model: string } });

test("flujo real: analizar, guardar, preguntar con memoria, listar y borrar", { skip, timeout: 240_000 }, async () => {
  const res = await api("/analisis", { method: "POST", body: JSON.stringify({ user_id: USER, month: "2026-09", facts }) });
  assert.equal(res.status, 200, await res.clone().text());
  const evs = await eventos(res);
  const done = evs.at(-1);
  assert.equal(done?.type, "done", JSON.stringify(done));
  const texto = evs.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.ok(texto.length > 200, "el análisis debería tener contenido");
  assert.equal(done?.analisis?.content, texto.trimEnd());
  assert.equal(done?.analisis?.model, config.model);
  assert.doesNotMatch(texto, /<think>|BANANA/); // sin razonamiento filtrado y sin obedecer la inyección del fixture

  const get = await api(`/analisis?user_id=${USER}&month=2026-09`);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { ...done?.analisis, created_at: ((await memory.analisis(USER, "2026-09")) ?? { created_at: "" }).created_at });

  // la recuperación por similitud (PGVectorStore) devuelve la memoria del usuario y nada de otro usuario
  const parecidas = await memory.buscar(USER, "análisis del gasto mensual y del ahorro", 4);
  assert.equal(parecidas.length, 1);
  assert.equal(parecidas[0]?.tipo, "analisis");
  assert.equal(parecidas[0]?.month, "2026-09");
  assert.deepEqual(await memory.buscar(OTRO, "análisis del gasto mensual y del ahorro", 4), []);

  const q = await eventos(await api("/preguntas", { method: "POST", body: JSON.stringify({ user_id: USER, question: "¿Cuánto he gastado en alquiler?", facts }) }));
  assert.deepEqual(q.at(-1), { type: "done" }, JSON.stringify(q.at(-1)));
  assert.match(q.filter((e) => e.type === "delta").map((e) => e.text).join(""), /650/);

  const lista = (await (await api(`/memorias?user_id=${USER}`)).json()) as { id: string; tipo: string; content: string }[];
  assert.deepEqual(lista.map((m) => m.tipo), ["conversacion", "analisis"]);
  assert.match(lista[0]?.content ?? "", /^Pregunta: ¿Cuánto he gastado en alquiler\?\nRespuesta: /);

  const id = lista[0]?.id ?? "";
  assert.equal((await api(`/memorias/${id}?user_id=${OTRO}`, { method: "DELETE" })).status, 404); // otro usuario no puede borrarla
  assert.equal((await api(`/memorias/${id}?user_id=${USER}`, { method: "DELETE" })).status, 204);
  assert.equal(((await (await api(`/memorias?user_id=${USER}`)).json()) as unknown[]).length, 1);
});

test("memoria real: un análisis reemplaza al del mismo mes y el contenido se trunca a 8000", { skip, timeout: 60_000 }, async () => {
  const user = randomUUID();
  try {
    const a = await memory.guardar(user, { tipo: "analisis", month: "2026-05", content: "primero", model: "m" });
    const b = await memory.guardar(user, { tipo: "analisis", month: "2026-05", content: "segundo", model: "m" });
    const c = await memory.guardar(user, { tipo: "conversacion", month: "2026-05", content: "x".repeat(9000), model: "m" });
    assert.equal(a.id, b.id);
    const lista = await memory.listar(user);
    assert.equal(lista.length, 2);
    assert.equal(lista.find((m) => m.tipo === "analisis")?.content, "segundo");
    assert.equal(c.content.length, 8000);
    assert.equal((await memory.analisis(user, "2026-05"))?.model, "m");
    // si el cliente se fue mientras se calculaba el embedding, no se inserta nada
    await assert.rejects(memory.guardar(user, { tipo: "conversacion", month: "2026-05", content: "cortada", model: "m" }, AbortSignal.abort()));
    assert.equal((await memory.listar(user)).length, 2);
  } finally {
    await pool.query("DELETE FROM memorias WHERE user_id = $1", [user]);
  }
});

test("salud real: Ollama, modelos y BD", { skip }, async () => {
  const res = await api("/salud");
  assert.deepEqual(await res.json(), { ollama: true, modelo: true, db: true });
});
