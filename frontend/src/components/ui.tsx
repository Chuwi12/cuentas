/**
 * Primitivas de UI compartidas. Todas las páginas las usan para que la app
 * se sienta un solo sistema. Si necesitas una variante, añádela aquí en vez
 * de copiar clases en la página.
 */
import {
  forwardRef, useEffect, useId, useRef,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
} from 'react'
import { X } from 'lucide-react'
import { Link, type LinkProps } from 'react-router-dom'
import { BUCKETS } from '../lib/buckets'
import { formatCents } from '../lib/money'
import type { Bucket, Kind } from '../lib/types'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')
export { cx }

// ── Botón ────────────────────────────────────────────────────────────────
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const variants: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-[#2a3f55] disabled:bg-ink-faint',
  secondary: 'bg-sheet text-ink border border-grid hover:border-ink-faint',
  ghost: 'text-ink-soft hover:text-ink hover:bg-rule',
  danger: 'bg-over text-white hover:bg-[#a51f1f]',
}

/** Clases de botón, para que un enlace (LinkButton) se vea igual que un Button.
 *  Ojo: `className` no puede anular `inline-flex` con `hidden` (en Tailwind gana
 *  el orden de la hoja, no el del atributo). Para ocultar, envuelve en otro elemento. */
function buttonClasses(variant: Variant, size: 'sm' | 'md', className?: string) {
  return cx(
    'inline-flex items-center justify-center gap-2 font-medium rounded-[var(--radius-control)]',
    'transition-colors disabled:cursor-not-allowed select-none',
    size === 'md' ? 'h-10 px-4 text-[15px]' : 'h-8 px-3 text-sm',
    variants[variant], className,
  )
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: 'sm' | 'md'; loading?: boolean
}>(function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
      {...rest}
    >
      {loading ? <span className="size-4 rounded-full border-2 border-current border-r-transparent animate-spin" /> : null}
      {children}
    </button>
  )
})

/** Enlace interno con aspecto de botón (navega, no ejecuta una acción). */
export function LinkButton({ variant = 'primary', size = 'md', className, ...rest }: LinkProps & {
  variant?: Variant; size?: 'sm' | 'md'
}) {
  return <Link className={buttonClasses(variant, size, className)} {...rest} />
}

// ── Campos de formulario ────────────────────────────────────────────────
const control =
  'w-full h-10 px-3 bg-sheet border border-grid rounded-[var(--radius-control)] text-ink ' +
  'placeholder:text-ink-faint focus:outline-none focus:border-needs focus:ring-2 focus:ring-needs/20 ' +
  'aria-[invalid=true]:border-over'

/** Etiqueta + control + pista/error, con ids enlazados para lectores de pantalla. */
export function Field({ label, error, hint, children }: {
  label: string; error?: string | null; hint?: string
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode
}) {
  const id = useId()
  const descId = error || hint ? `${id}-desc` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': descId })}
      {error ? <p id={descId} className="text-sm text-over">{error}</p>
        : hint ? <p id={descId} className="text-sm text-ink-soft">{hint}</p> : null}
    </div>
  )
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(control, className)} {...rest} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return <select ref={ref} className={cx(control, 'pr-8', className)} {...rest}>{children}</select>
  },
)

/** Conmutador de dos o tres opciones (p. ej. Gasto / Ingreso). */
export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-0.5 bg-rule rounded-[var(--radius-control)]">
      {options.map((o) => (
        <button
          key={o.value} type="button" role="radio" aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-9 px-4 text-sm font-medium rounded-[5px] transition-colors',
            value === o.value ? 'bg-sheet text-ink shadow-sm' : 'text-ink-soft hover:text-ink',
          )}
        >{o.label}</button>
      ))}
    </div>
  )
}

// ── Diálogo (dialog nativo: foco atrapado y Escape gratis) ──────────────
export function Dialog({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] p-0 bg-sheet text-ink rounded-[var(--radius-panel)] shadow-[var(--shadow-lift)]"
    >
      {open ? (
        <div className="flex flex-col max-h-[calc(100dvh-2rem)]">
          <header className="flex items-center justify-between gap-4 px-5 pt-4 pb-3 border-b border-rule">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Cerrar" className="p-1.5 -mr-1.5 rounded text-ink-soft hover:text-ink hover:bg-rule">
              <X size={18} />
            </button>
          </header>
          <div className="px-5 py-4 overflow-y-auto">{children}</div>
          {footer ? <footer className="flex justify-end gap-2 px-5 py-3 border-t border-rule">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  )
}

// ── Dinero y cubos ──────────────────────────────────────────────────────
/** Importe con signo según tipo: ingreso en verde "+", gasto en tinta "−". */
export function Money({ cents, kind, className }: { cents: number; kind?: Kind; className?: string }) {
  const sign = kind === 'income' ? '+' : kind === 'expense' ? '−' : ''
  return (
    <span className={cx('tabular whitespace-nowrap', kind === 'income' && 'text-income', className)}>
      {sign}{formatCents(cents)}
    </span>
  )
}

export function BucketTag({ bucket }: { bucket: Bucket }) {
  const b = BUCKETS[bucket]
  return (
    <span className={cx('inline-flex items-center gap-1.5 h-6 px-2 rounded text-xs font-medium', b.soft, b.text)}>
      <span className={cx('size-1.5 rounded-full', b.bg)} aria-hidden />
      {b.label}
    </span>
  )
}

/** Anotación a mano en rojo, como una corrección en la libreta.
 *  SOLO para señalar que un cubo se ha pasado de su objetivo. */
export function RedPenNote({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-hand text-over text-xl leading-none -rotate-2 inline-block', className)}>{children}</span>
}

// ── Estados ─────────────────────────────────────────────────────────────
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 py-10 px-1 max-w-md">
      <p className="text-lg font-semibold">{title}</p>
      {children ? <div className="text-ink-soft">{children}</div> : null}
      {action}
    </div>
  )
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Algo ha fallado al cargar los datos.'
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-[var(--radius-control)] bg-over-soft text-over text-sm">
      <span>{message}</span>
      {onRetry ? <Button size="sm" variant="secondary" onClick={onRetry}>Reintentar</Button> : null}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('bg-rule rounded animate-pulse', className)} aria-hidden />
}

/** Cabecera de página: título a la izquierda, acciones a la derecha. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
      <h1 className="text-[28px] leading-tight font-bold tracking-[-0.01em]">{title}</h1>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  )
}
