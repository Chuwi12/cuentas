import type { ReactNode } from 'react'
import { Skeleton, cx } from '../../components/ui'

/** Hoja del asesor: donde escribe el modelo. `header` es opcional (estado, acciones). */
export function Sheet({ header, children, className }: { header?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-[var(--radius-panel)] border border-grid bg-sheet', className)}>
      {header ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 md:px-8 py-3 border-b border-rule">
          {header}
        </div>
      ) : null}
      <div className="px-5 md:px-8 py-5 md:py-6">{children}</div>
    </div>
  )
}

/** Texto del asesor. Es salida de un modelo: se pinta siempre como texto plano, nunca como HTML. */
export function AdvisorText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="max-w-[68ch] whitespace-pre-wrap break-words leading-[1.7]">
      {text}
      {/* La punta de la pluma: solo mientras escribe. Sin animación si se pide menos movimiento. */}
      {streaming ? (
        <span aria-hidden className="inline-block w-[2px] h-[1.1em] ml-0.5 align-text-bottom bg-ink motion-safe:animate-pulse" />
      ) : null}
    </div>
  )
}

/** Marcador mientras el modelo carga y lee las cifras, antes de la primera palabra. */
export function Waiting() {
  return (
    <div className="flex flex-col gap-2.5 max-w-[68ch]" aria-hidden>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}
