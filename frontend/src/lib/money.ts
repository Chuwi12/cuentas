// Todo el dinero es entero de céntimos. Aquí y solo aquí se convierte a texto.

const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' })
const eurRound = new Intl.NumberFormat('es-ES', {
  style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
})

/** 123456 → "1234,56 €" */
export function formatCents(cents: number): string {
  return eur.format(cents / 100)
}

/** 123456 → "1235 €". Para ejes de gráficos y cifras grandes. */
export function formatCentsRound(cents: number): string {
  return eurRound.format(Math.round(cents / 100))
}

/**
 * Texto que escribe la persona → céntimos. Acepta "12,34", "12.34",
 * "1.234,56", "1234" y "12,5". Devuelve null si no es un importe válido > 0.
 * Se hace con enteros, sin pasar por float, para no perder céntimos.
 */
export function parseAmountToCents(input: string): number | null {
  let s = input.trim().replace(/\s|€/g, '')
  if (!s) return null
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  const decSep = lastComma > lastDot ? ',' : lastDot > lastComma ? '.' : null
  let intPart = s
  let decPart = ''
  if (decSep) {
    const idx = s.lastIndexOf(decSep)
    const tail = s.slice(idx + 1)
    // "1.234" con punto y 3 dígitos detrás es separador de miles, no decimal.
    if (tail.length === 3 && decSep === '.' && lastComma === -1) {
      intPart = s
    } else {
      intPart = s.slice(0, idx)
      decPart = tail
    }
  }
  intPart = intPart.replace(/[.,]/g, '')
  if (!/^\d+$/.test(intPart) || !/^\d{0,2}$/.test(decPart)) return null
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0') || '0')
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

/** 1234 → "12,34" (para rellenar un input al editar). */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',')
}
