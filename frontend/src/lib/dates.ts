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
