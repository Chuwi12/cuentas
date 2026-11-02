import type { ImportDateFormat, ImportDecimal, ImportInspect, ImportMapping, ImportPreview } from '../../lib/types'

/** Estado del formulario de mapeo: columnas elegidas (o null) y opciones de lectura. */
export interface MappingForm {
  date: number | null
  amount: number | null
  description: number | null
  reference: number | null
  has_header: boolean
  date_format: ImportDateFormat
  decimal: ImportDecimal
  invert_sign: boolean
}

const DATE_FORMATS: ImportDateFormat[] = ['auto', 'ymd', 'dmy', 'mdy']
const DECIMALS: ImportDecimal[] = ['auto', 'comma', 'dot']

/** Cómo se dice en la pantalla el formato con el que el servidor ha leído las fechas. */
export const DATE_FORMAT_NAME: Record<ImportPreview['date_format'], string> = {
  ymd: 'año-mes-día',
  dmy: 'día/mes/año',
  mdy: 'mes/día/año',
}

/** Columnas del fichero: la fila más ancha de las que se ven. Un CSV que abre con una línea de
 *  título ("Movimientos de la cuenta…") tiene una primera fila de una sola celda. */
export function columnCount(inspect: ImportInspect): number {
  return Math.max(inspect.headers.length, ...inspect.sample.map((r) => r.length))
}

/** Nombre de cada columna: la cabecera, o "Columna N" si no la hay (o no es cabecera). */
export function columnNames(inspect: ImportInspect, hasHeader: boolean): string[] {
  return Array.from({ length: columnCount(inspect) }, (_, i) => (hasHeader && inspect.headers[i]?.trim()) || `Columna ${i + 1}`)
}

/** Propone fecha, importe y descripción por el nombre de la cabecera. La referencia del banco nunca
 *  se elige sola: en muchos bancos es la del mandato de un recibo, o "0", y se repite entre movimientos.
 *  Si la primera fila parece datos, no hay cabecera. */
export function guessForm(headers: string[]): MappingForm {
  const hasHeader = !headers.some((h) => /^\s*[-+]?\d[\d.,/:\s-]*$/.test(h))
  const used = new Set<number>()
  const find = (re: RegExp) => {
    // Una primera fila de una sola celda es un título, no las cabeceras: no hay nombres de los que fiarse.
    if (!hasHeader || headers.length < 2) return null
    const i = headers.findIndex((h, k) => !used.has(k) && re.test(h))
    if (i >= 0) used.add(i)
    return i >= 0 ? i : null
  }
  return {
    date: find(/fecha|date/i),
    amount: find(/importe|amount|cantidad|monto/i),
    description: find(/concepto|descrip|detalle|movimiento|memo|observ|payee/i),
    reference: null,
    has_header: hasHeader,
    date_format: 'auto',
    decimal: 'auto',
    invert_sign: false,
  }
}

/** Formulario → cuerpo del contrato. null mientras falte fecha o importe. */
export function toMapping(f: MappingForm): ImportMapping | null {
  if (f.date === null || f.amount === null) return null
  return {
    date: f.date,
    amount: f.amount,
    description: f.description,
    reference: f.reference,
    has_header: f.has_header,
    date_format: f.date_format,
    decimal: f.decimal,
    invert_sign: f.invert_sign,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

// ── Último mapeo, por lista de cabeceras ─────────────────────────────────
const SEP = '\u001f'

/** cyrb53: hash de 53 bits. De las cabeceras solo se guarda esto, nunca su texto: la primera
 *  fila puede ser un título con datos de la cuenta. */
function hash(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const storageKey = (headers: string[]) => `finanzas.import.mapping.${hash(headers.join(SEP))}`

/** El mapeo guardado para estas cabeceras, o null. Solo se aplica si la lista de cabeceras coincide
 *  (la clave sale de ella) y las columnas guardadas caben en el fichero actual. */
export function loadMapping(inspect: ImportInspect): MappingForm | null {
  try {
    const raw = localStorage.getItem(storageKey(inspect.headers))
    if (!raw) return null
    const f = JSON.parse(raw) as Partial<Record<keyof MappingForm, unknown>>
    const width = columnCount(inspect)
    const col = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < width ? x : null)
    const date = col(f.date)
    const amount = col(f.amount)
    if (date === null || amount === null || f.has_header !== true) return null
    return {
      date,
      amount,
      description: col(f.description),
      reference: col(f.reference),
      has_header: true,
      date_format: DATE_FORMATS.find((x) => x === f.date_format) ?? 'auto',
      decimal: DECIMALS.find((x) => x === f.decimal) ?? 'auto',
      invert_sign: f.invert_sign === true,
    }
  } catch {
    return null
  }
}

/** Sin cabecera, la "lista de cabeceras" es un movimiento real: no se guarda nada. */
export function saveMapping(headers: string[], form: MappingForm): void {
  if (!form.has_header) return
  try {
    localStorage.setItem(storageKey(headers), JSON.stringify(form))
  } catch {
    // Sin almacenamiento (modo privado, bloqueado): el mapeo simplemente no se recuerda.
  }
}
