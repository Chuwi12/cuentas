import { formatMonth } from '../../lib/dates'

/** "2026-09" → "Septiembre de 2026". `formatMonth` da todo en minúsculas
 *  (correcto en frase); esto solo mayusculiza la inicial para un título. */
export function capitalizeMonth(month: string): string {
  const s = formatMonth(month)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Porcentaje con coma decimal, como el resto de cifras de la app. */
export function formatPct(value: number, digits = 1): string {
  return `${value.toFixed(digits).replace('.', ',')} %`
}
