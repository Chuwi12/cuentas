import type { Bucket } from './types'

/** Nombre, objetivo y colores (clases Tailwind de app.css) de cada cubo. */
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
             text: 'text-needs', bg: 'bg-needs', soft: 'bg-needs-soft', hex: '#2B5F8A' },
  wants:   { label: 'Deseos', pct: 30, hint: 'Lo que eliges: ocio, ropa, caprichos',
             text: 'text-wants', bg: 'bg-wants', soft: 'bg-wants-soft', hex: '#B8487E' },
  savings: { label: 'Ahorro', pct: 20, hint: 'Inversión y lo que no gastas',
             text: 'text-savings', bg: 'bg-savings', soft: 'bg-savings-soft', hex: '#2E7D64' },
}

export const BUCKET_ORDER: Bucket[] = ['needs', 'wants', 'savings']
