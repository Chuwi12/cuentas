// Fechas de operación como "YYYY-MM-DD" y meses como "YYYY-MM", sin zonas horarias.

const pad = (n: number) => String(n).padStart(2, '0')

export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function currentMonth(): string {
  return todayISO().slice(0, 7)
}

/** "2026-09" + (-1) → "2026-08" */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** "2026-09" → { from: "2026-09-01", to: "2026-09-30" } */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${pad(last)}` }
}

const monthLong = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' })
const monthShort = new Intl.DateTimeFormat('es-ES', { month: 'short' })
const dayFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' })

/** "2026-09" → "septiembre de 2026" */
export function formatMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return monthLong.format(new Date(y, m - 1, 1))
}

/** "2026-09" → "sept" */
export function formatMonthShort(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return monthShort.format(new Date(y, m - 1, 1)).replace('.', '')
}

/** "2026-09-21" → "21 sept" */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return dayFmt.format(new Date(y, m - 1, d)).replace('.', '')
}

/** "2026-09" → "Septiembre de 2026", para títulos y selectores de mes.
 *  No uses la clase CSS `capitalize`: pondría "Septiembre De 2026". */
export function formatMonthTitle(month: string): string {
  const s = formatMonth(month)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Periodos de informe (semana ISO lunes-domingo, mes, año) ─────────────
type PeriodKind = 'week' | 'month' | 'year'

function fromISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Primer y último día (inclusivos) del periodo que contiene `date`. */
export function periodRange(kind: PeriodKind, date: string): { from: string; to: string } {
  const d = fromISO(date)
  if (kind === 'year') return { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` }
  if (kind === 'month') return monthRange(date.slice(0, 7))
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  return { from: toISO(monday), to: toISO(sunday) }
}

/** Primer día del periodo anterior (-1) o siguiente (+1) al que contiene `date`. */
export function shiftPeriod(kind: PeriodKind, date: string, delta: number): string {
  const { from } = periodRange(kind, date)
  const d = fromISO(from)
  if (kind === 'year') return toISO(new Date(d.getFullYear() + delta, 0, 1))
  if (kind === 'month') return toISO(new Date(d.getFullYear(), d.getMonth() + delta, 1))
  return toISO(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * delta))
}

const dayMonthShort = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' })
const monthYearLong = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' })
const weekdayShort = new Intl.DateTimeFormat('es-ES', { weekday: 'short' })

/** "2026-09-22".."2026-09-28" → "semana del 22 al 28 sep 2026";
 *  mes → "septiembre 2026"; año → "2026". Sin mayúscula inicial (va en frases y en el PDF). */
export function formatPeriodLabel(kind: PeriodKind, from: string, to: string): string {
  const a = fromISO(from)
  const b = fromISO(to)
  if (kind === 'year') return String(a.getFullYear())
  if (kind === 'month') return monthYearLong.format(a).replace(' de ', ' ')
  const short = (d: Date) => dayMonthShort.format(d).replace(/\./g, '')
  if (a.getFullYear() !== b.getFullYear()) return `semana del ${short(a)} ${a.getFullYear()} al ${short(b)} ${b.getFullYear()}`
  if (a.getMonth() !== b.getMonth()) return `semana del ${short(a)} al ${short(b)} ${b.getFullYear()}`
  return `semana del ${a.getDate()} al ${short(b)} ${b.getFullYear()}`
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** "2026-09-22" → "lun" */
export function formatWeekdayShort(iso: string): string {
  return weekdayShort.format(fromISO(iso)).replace('.', '')
}

/** "2026-09-22" → "22/09/2026" */
export function formatDateNumeric(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}
