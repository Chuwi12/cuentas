import { useEffect, useRef, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cx } from '../../components/ui'

const STEPS = ['Fichero', 'Columnas', 'Revisión', 'Resultado']

/** Los cuatro pasos, en orden. En móvil solo el paso actual muestra su nombre. */
export function Stepper({ current }: { current: number }) {
  return (
    <ol aria-label="Pasos de la importación" className="flex items-center gap-2 mb-8 text-sm">
      {STEPS.map((label, i) => (
        <li
          key={label}
          aria-current={i === current ? 'step' : undefined}
          className={cx('flex items-center gap-2', i < STEPS.length - 1 && 'flex-1')}
        >
          <span className={cx(
            'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular',
            i <= current ? 'bg-ink text-white' : 'border border-grid text-ink-soft',
          )}>
            {i < current ? <Check size={14} strokeWidth={2.5} aria-hidden /> : i + 1}
          </span>
          <span className={cx('font-medium', i === current ? 'text-ink' : 'text-ink-soft max-sm:sr-only')}>
            {label}{i < current ? <span className="sr-only">, completado</span> : null}
          </span>
          {i < STEPS.length - 1 ? <span className="h-px flex-1 bg-grid" aria-hidden /> : null}
        </li>
      ))}
    </ol>
  )
}

/** Encabezado del paso. Al avanzar o volver recibe el foco, para que el lector de pantalla
 *  anuncie dónde está y el teclado siga desde ahí. */
export function StepHeading({ children, focus }: { children: ReactNode; focus: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (focus) ref.current?.focus() }, [focus])
  return <h2 ref={ref} tabIndex={-1} className="text-xl font-semibold mb-1 scroll-mt-6">{children}</h2>
}
