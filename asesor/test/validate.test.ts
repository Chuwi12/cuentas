import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { HttpError } from "../src/http.ts";
import { parseDate, parseFacts, parseMonth, parseQuestion, parseUuid, previousMonth } from "../src/validate.ts";

const invalido = (fn: () => unknown) =>
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === 422 && e.code === "validation");

test("parseUuid: acepta UUID, normaliza a minúsculas y rechaza el resto", () => {
  assert.equal(parseUuid("AAAAAAAA-1111-4111-8111-111111111111", "user_id"), "aaaaaaaa-1111-4111-8111-111111111111");
  for (const v of ["", "x", "1111", 7, null, undefined, "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-1111111111111", "g1111111-1111-4111-8111-111111111111"]) {
    invalido(() => parseUuid(v, "user_id"));
  }
});

test("parseMonth: YYYY-MM con mes 01-12 y año 2000-2100", () => {
  assert.equal(parseMonth("2026-09"), "2026-09");
  assert.equal(parseMonth("2000-01"), "2000-01");
  assert.equal(parseMonth("2100-12"), "2100-12");
  for (const v of ["2026-13", "2026-00", "2026-9", "26-09", "1999-12", "2101-01", "2026-09-01", " 2026-09", null, 202609]) invalido(() => parseMonth(v));
});

test("parseQuestion: recorta y exige entre 1 y 1000 caracteres", () => {
  assert.equal(parseQuestion("  ¿Cuánto gasto?  "), "¿Cuánto gasto?");
  assert.equal(parseQuestion("a".repeat(1000)).length, 1000);
  assert.equal([...parseQuestion("😀".repeat(1000))].length, 1000); // caracteres, no unidades UTF-16
  assert.equal(parseQuestion("hola\0 mundo"), "hola mundo");
  for (const v of ["", "   ", "\n\t", "a".repeat(1001), "😀".repeat(1001), 5, null, undefined]) invalido(() => parseQuestion(v));
});

test("parseFacts: exige objeto con summary, report, trend y un month válido", () => {
  const ok = { month: "2026-09", today: "2026-10-02", month_in_progress: true, summary: {}, report: {}, trend: {} };
  assert.equal(parseFacts(ok).month_in_progress, true);
  for (const v of [null, [], "x", { ...ok, month: "2026-9" }, { ...ok, today: "mañana" }, { ...ok, today: undefined }, { ...ok, summary: null }, { ...ok, report: [] }, { ...ok, trend: undefined }]) invalido(() => parseFacts(v));
});

test("parseDate: YYYY-MM-DD real", () => {
  assert.equal(parseDate("2026-10-02", "facts.today"), "2026-10-02");
  assert.equal(parseDate("2028-02-29", "facts.today"), "2028-02-29");
  for (const v of ["2026-02-29", "2026-13-01", "2026-10-32", "2026-04-31", "2026-00-10", "2026-1-02", "2026-10-02T00:00:00Z", " 2026-10-02", "ayer", "", 20261002, null, undefined]) invalido(() => parseDate(v, "facts.today"));
});

test("previousMonth: pasa de enero al diciembre anterior", () => {
  assert.equal(previousMonth("2026-10"), "2026-09");
  assert.equal(previousMonth("2026-01"), "2025-12");
});

test("loadConfig: sin token o con token corto no arranca", () => {
  const ok = { ASESOR_TOKEN: "t".repeat(32), ASESOR_DATABASE_URL: "postgres://x:y@127.0.0.1:5435/asesor" };
  assert.throws(() => loadConfig({ ASESOR_DATABASE_URL: ok.ASESOR_DATABASE_URL }), /ASESOR_TOKEN es obligatoria/);
  assert.throws(() => loadConfig({ ...ok, ASESOR_TOKEN: "t".repeat(31) }), /al menos 32 caracteres/);
  assert.throws(() => loadConfig({ ASESOR_TOKEN: ok.ASESOR_TOKEN }), /ASESOR_DATABASE_URL es obligatoria/);
  assert.throws(() => loadConfig({}), /ASESOR_TOKEN[\s\S]*ASESOR_DATABASE_URL/); // lista todos los fallos
});

test("loadConfig: defectos de docs/ASESOR.md y validación de valores", () => {
  const ok = { ASESOR_TOKEN: "t".repeat(32), ASESOR_DATABASE_URL: "postgres://x:y@127.0.0.1:5435/asesor" };
  const c = loadConfig(ok);
  assert.deepEqual([c.port, c.ollamaUrl, c.model, c.embedModel, c.numCtx, c.keepAlive], [8090, "http://127.0.0.1:11434", "qwen3.5:4b", "embeddinggemma:300m-qat-q8_0", 4096, "5m"]);
  assert.equal(loadConfig({ ...ok, ASESOR_KEEP_ALIVE: "300" }).keepAlive, 300);
  assert.equal(loadConfig({ ...ok, OLLAMA_URL: "http://127.0.0.1:11434/" }).ollamaUrl, "http://127.0.0.1:11434");
  assert.throws(() => loadConfig({ ...ok, ASESOR_PORT: "70000" }), /ASESOR_PORT/);
  assert.throws(() => loadConfig({ ...ok, ASESOR_NUM_CTX: "abc" }), /ASESOR_NUM_CTX/);
  assert.throws(() => loadConfig({ ...ok, ASESOR_KEEP_ALIVE: "mucho" }), /ASESOR_KEEP_ALIVE/);
  assert.throws(() => loadConfig({ ...ok, OLLAMA_URL: "no es url" }), /OLLAMA_URL/);
});

test("loadConfig: no arranca si LangChain enviaría trazas a LangSmith", () => {
  const ok = { ASESOR_TOKEN: "t".repeat(32), ASESOR_DATABASE_URL: "postgres://x:y@127.0.0.1:5435/asesor" };
  for (const v of ["LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING", "LANGCHAIN_TRACING"]) {
    for (const valor of ["true", "TRUE", " true "]) {
      assert.throws(() => loadConfig({ ...ok, [v]: valor }), new RegExp(`${v}=true[\\s\\S]*no envía datos fuera de la máquina`));
    }
    assert.doesNotThrow(() => loadConfig({ ...ok, [v]: "false" }));
  }
  assert.doesNotThrow(() => loadConfig({ ...ok, LANGSMITH_API_KEY: "x" })); // la clave sola no activa nada
});

test("loadConfig: OLLAMA_URL solo de esta máquina (127.0.0.1, ::1, localhost) o https", () => {
  const ok = { ASESOR_TOKEN: "t".repeat(32), ASESOR_DATABASE_URL: "postgres://x:y@127.0.0.1:5435/asesor" };
  for (const url of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434", "http://LOCALHOST:11434/", "https://ollama.example.com", "https://10.0.0.5:11434"]) {
    assert.equal(loadConfig({ ...ok, OLLAMA_URL: url }).ollamaUrl, url.replace(/\/+$/, ""), url);
  }
  for (const url of ["http://ollama.example.com:11434", "http://192.168.1.20:11434", "http://10.0.0.5:11434", "http://0.0.0.0:11434", "http://127.0.0.1.evil.example:11434", "http://localhost.evil.example", "ftp://127.0.0.1"]) {
    assert.throws(() => loadConfig({ ...ok, OLLAMA_URL: url }), /OLLAMA_URL/, url);
  }
});
