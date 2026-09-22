import type { Bucket } from './types'

/** Nombre, objetivo y colores de cada cubo. `text` es la variante -ink (AA para
 *  texto); `bg` y `hex` son el relleno, para barras y gráficos. */
export const BUCKETS: Record<Bucket, {
  label: string
  pct: number
  hint: string
  text: string
  bg: string
  soft: string
  hex: string
}> = {
  needs:   { label: 'Necesidades', pct: 50, hint: 'Lo imprescindible: casa, comida, facturas',
             text: 'text-needs-ink', bg: 'bg-needs', soft: 'bg-needs-soft', hex: '#2463B5' },
  wants:   { label: 'Deseos', pct: 30, hint: 'Lo que eliges: ocio, ropa, caprichos',
             text: 'text-wants-ink', bg: 'bg-wants', soft: 'bg-wants-soft', hex: '#D08B19' },
  savings: { label: 'Ahorro', pct: 20, hint: 'Inversión y lo que no gastas',
             text: 'text-savings-ink', bg: 'bg-savings', soft: 'bg-savings-soft', hex: '#138A6B' },
}

export const BUCKET_ORDER: Bucket[] = ['needs', 'wants', 'savings']
