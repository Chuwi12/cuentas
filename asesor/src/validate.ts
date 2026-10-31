import { HttpError } from "./http.ts";

export type Obj = Record<string, unknown>;

/** Lo que calcula Rust (docs/ASESOR.md > Facts). Solo se valida la forma exterior; compact.ts tolera huecos. */
export interface Facts {
  month: string;
  today: string;
  month_in_progress: boolean;
  summary: Obj;
  report: Obj;
  trend: Obj;
}

export const MAX_QUESTION = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (msg: string) => new HttpError(422, "validation", msg);

/** En minúsculas: el filtro de la memoria compara texto y la columna uuid normaliza. */
export function parseUuid(v: unknown, campo: string): string {
  if (typeof v !== "string" || !UUID.test(v)) throw bad(`${campo} no es un UUID válido.`);
  return v.toLowerCase();
}

export function parseMonth(v: unknown, campo = "month"): string {
  const m = typeof v === "string" ? MONTH.exec(v) : null;
  const year = Number(m?.[1]);
  if (!m || year < 2000 || year > 2100) throw bad(`${campo} debe tener el formato YYYY-MM (años 2000 a 2100).`);
  return m[0];
}

export function parseQuestion(v: unknown): string {
  // Sin NUL (Postgres lo rechaza) y contando caracteres, no unidades UTF-16, como hace Rust.
  const q = typeof v === "string" ? v.replaceAll("\0", "").trim() : "";
  const len = [...q].length;
  if (len < 1 || len > MAX_QUESTION) throw bad(`question debe tener entre 1 y ${MAX_QUESTION} caracteres.`);
  return q;
}

export function parseDate(v: unknown, campo: string): string {
  // Fecha existente de verdad (no 2026-02-30): se reconstruye y se compara; una fecha imposible da Invalid Date.
  const d = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad(`${campo} debe ser una fecha YYYY-MM-DD válida.`);
  return v as string;
}

export function parseFacts(v: unknown): Facts {
  if (!isObj(v)) throw bad("facts debe ser un objeto.");
  for (const k of ["summary", "report", "trend"]) if (!isObj(v[k])) throw bad(`facts.${k} debe ser un objeto.`);
  return {
    month: parseMonth(v.month, "facts.month"),
    today: parseDate(v.today, "facts.today"),
    month_in_progress: v.month_in_progress === true,
    summary: v.summary as Obj,
    report: v.report as Obj,
    trend: v.trend as Obj,
  };
}

export function parseObject(v: unknown): Obj {
  if (!isObj(v)) throw bad("El cuerpo debe ser un objeto JSON.");
  return v;
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
