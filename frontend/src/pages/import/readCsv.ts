/** Límite del contrato: 2 MB de CSV. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024

export function formatBytes(n: number): string {
  return n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}

const DELIMITERS: Record<string, string> = { ';': 'punto y coma', ',': 'coma', '\t': 'tabulador' }
export const delimiterName = (d: string) => DELIMITERS[d] ?? `«${d}»`

/** Lee el fichero en el navegador. UTF-8 si es válido; si no (muchos bancos españoles exportan
 *  en windows-1252), se vuelve a leer como windows-1252. Los errores llevan el mensaje para el usuario. */
export async function readCsvFile(file: File): Promise<string> {
  if (!/\.csv$/i.test(file.name)) throw new Error('Elige un fichero con extensión .csv.')
  if (file.size === 0) throw new Error('El fichero está vacío.')
  if (file.size > MAX_CSV_BYTES) {
    throw new Error(`El fichero pesa ${formatBytes(file.size)} y el máximo es 2 MB. Exporta un periodo más corto.`)
  }
  const buf = await file.arrayBuffer()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf) // quita el BOM
  } catch {
    text = new TextDecoder('windows-1252').decode(buf)
  }
  // Se envía como UTF-8: con tildes de windows-1252 puede pesar más que el fichero.
  if (new Blob([text]).size > MAX_CSV_BYTES) {
    throw new Error('El fichero, ya convertido a UTF-8, supera los 2 MB. Exporta un periodo más corto.')
  }
  return text
}
