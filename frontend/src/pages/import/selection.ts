import type { ImportRow } from '../../lib/types'

/** Lo que el usuario cambia en la previsualización. `off`: filas válidas que desmarca.
 *  `cats`: solo las categorías distintas de la sugerida (es lo que pide el contrato). */
export interface Picks {
  off: Set<number>
  cats: Record<number, string | null>
}

export const noPicks = (): Picks => ({ off: new Set(), cats: {} })

/** Las erróneas y las duplicadas no se pueden incluir. */
export const isSelectable = (r: ImportRow) => !r.error && !r.duplicate
