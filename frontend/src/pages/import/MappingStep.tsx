import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Button, ErrorNote, Field, Select, cx } from '../../components/ui'
import type { ImportDateFormat, ImportDecimal, ImportInspect } from '../../lib/types'
import { columnNames, type MappingForm } from './mapping'
import { StepHeading } from './Steps'

const DATE_FORMATS: { value: ImportDateFormat; label: string }[] = [
  { value: 'auto', label: 'Automático' },
  { value: 'ymd', label: 'Año-mes-día (2026-10-31)' },
  { value: 'dmy', label: 'Día/mes/año (31/10/2026)' },
  { value: 'mdy', label: 'Mes/día/año (10/31/2026)' },
]
const DECIMALS: { value: ImportDecimal; label: string }[] = [
  { value: 'auto', label: 'Automático' },
  { value: 'comma', label: 'Coma (1.234,56)' },
  { value: 'dot', label: 'Punto (1,234.56)' },
]

const clip = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const toIndex = (v: string) => (v === '' ? null : Number(v))

/** Paso 2: qué columna es cada dato. La muestra del fichero marca las columnas elegidas. */
export function MappingStep({ inspect, form, remembered, pending, error, dateFormatError, focusHeading, focusDateFormat, onChange, onBack, onSubmit }: {
  inspect: ImportInspect
  form: MappingForm
  remembered: boolean
  pending: boolean
  /** Error de la previsualización que no es del formato de fecha: va junto al botón. */
  error: unknown
  /** Mensaje del servidor cuando no ha podido deducir el formato de fecha: va junto a ese campo. */
  dateFormatError: string | null
  focusHeading: boolean
  /** Se llega desde la previsualización para cambiar el formato: el foco va a ese campo. */
  focusDateFormat: boolean
  onChange: (patch: Partial<MappingForm>) => void
  onBack: () => void
  onSubmit: () => void
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const dateFormatRef = useRef<HTMLSelectElement>(null)
  const [showErrors, setShowErrors] = useState(false)

  // Al fallar la previsualización el botón deshabilitado suelta el foco: se devuelve ahí, junto al aviso.
  useEffect(() => { if (error) submitRef.current?.focus() }, [error])
  // Si el servidor no sabe qué formato de fecha es, se lleva al usuario al campo que lo decide.
  useEffect(() => { if (dateFormatError || focusDateFormat) dateFormatRef.current?.focus() }, [dateFormatError, focusDateFormat])

  const names = useMemo(() => columnNames(inspect, form.has_header), [inspect, form.has_header])
  // Sin cabecera, la primera fila también es un dato: sirve de ejemplo.
  const rows = useMemo(
    () => (form.has_header ? inspect.sample : [inspect.headers, ...inspect.sample]).slice(0, 5),
    [inspect, form.has_header],
  )
  const options = names.map((name, i) => {
    const example = rows.map((r) => r[i]?.trim()).find(Boolean)
    return <option key={i} value={i}>{example ? `${clip(name, 32)} (ej. ${clip(example)})` : clip(name, 32)}</option>
  })

  const tags = new Map<number, string[]>()
  for (const [role, col] of [['Fecha', form.date], ['Importe', form.amount], ['Descripción', form.description], ['Referencia', form.reference]] as const) {
    if (col !== null) tags.set(col, [...(tags.get(col) ?? []), role])
  }

  const missing = (col: number | null, what: string) => (showErrors && col === null ? `Elige la columna ${what}.` : null)

  function submit(e: FormEvent) {
    e.preventDefault()
    if (form.date === null || form.amount === null) {
      setShowErrors(true)
      // Espera al render que marca aria-invalid y lleva el foco al primer campo que falta.
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    onSubmit()
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate>
      <StepHeading focus={focusHeading && !focusDateFormat}>Indica qué columna es cada dato</StepHeading>
      <p className="text-ink-soft max-w-[68ch] mb-6">
        Las columnas elegidas se marcan en las primeras filas de tu fichero.
        {remembered ? ' Hemos recuperado lo que elegiste la última vez con estas mismas columnas.' : ''}
      </p>

      <SampleTable names={names} rows={rows} tags={tags} />

      {/* Mientras se previsualiza no se toca nada: la petición ya lleva este mapeo. */}
      <fieldset disabled={pending} className="min-w-0 max-w-3xl mt-8"><div className="flex flex-col gap-6">
        <CheckField
          checked={form.has_header}
          onChange={(has_header) => onChange({ has_header })}
          label="La primera fila es cabecera"
          hint="Desmárcalo si el fichero empieza directamente por movimientos."
        />

        <div className="grid gap-x-6 gap-y-5 lg:grid-cols-2">
          <Field label="Fecha" error={missing(form.date, 'de la fecha')}>
            {(p) => (
              <Select {...p} value={form.date ?? ''} onChange={(e) => onChange({ date: toIndex(e.target.value) })}>
                <option value="" disabled>Elige una columna</option>
                {options}
              </Select>
            )}
          </Field>
          <Field label="Importe" error={missing(form.amount, 'del importe')}>
            {(p) => (
              <Select {...p} value={form.amount ?? ''} onChange={(e) => onChange({ amount: toIndex(e.target.value) })}>
                <option value="" disabled>Elige una columna</option>
                {options}
              </Select>
            )}
          </Field>
          <Field label="Descripción (opcional)">
            {(p) => (
              <Select {...p} value={form.description ?? ''} onChange={(e) => onChange({ description: toIndex(e.target.value) })}>
                <option value="">No usar</option>
                {options}
              </Select>
            )}
          </Field>
          <Field label="Referencia del banco (opcional)" hint="Elígela solo si el banco da un identificador distinto para cada movimiento. Si se repite (recibos domiciliados, ceros o guiones), déjala en «No usar».">
            {(p) => (
              <Select {...p} value={form.reference ?? ''} onChange={(e) => onChange({ reference: toIndex(e.target.value) })}>
                <option value="">No usar</option>
                {options}
              </Select>
            )}
          </Field>
          <Field label="Formato de fecha" error={dateFormatError}>
            {(p) => (
              <Select {...p} ref={dateFormatRef} value={form.date_format} onChange={(e) => onChange({ date_format: e.target.value as ImportDateFormat })}>
                {DATE_FORMATS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Separador decimal">
            {(p) => (
              <Select {...p} value={form.decimal} onChange={(e) => onChange({ decimal: e.target.value as ImportDecimal })}>
                {DECIMALS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            )}
          </Field>
        </div>

        <CheckField
          checked={form.invert_sign}
          onChange={(invert_sign) => onChange({ invert_sign })}
          label="Los gastos vienen en positivo"
          hint="Actívalo si tu banco no pone el signo menos a los gastos."
        />

        {error ? <ErrorNote error={error} /> : null}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={onBack}>Atrás</Button>
          <Button ref={submitRef} type="submit" loading={pending}>Previsualizar movimientos</Button>
        </div>
      </div></fieldset>
    </form>
  )
}

function CheckField({ checked, onChange, label, hint }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint: string
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={`${id}-hint`}
        className="mt-0.5 size-5 shrink-0 cursor-pointer accent-ink"
      />
      <div>
        <label htmlFor={id} className="font-medium text-[15px] cursor-pointer">{label}</label>
        <p id={`${id}-hint`} className="text-sm text-ink-soft">{hint}</p>
      </div>
    </div>
  )
}

/** Primeras filas del fichero. Las columnas elegidas se tiñen y llevan su rol escrito. */
function SampleTable({ names, rows, tags }: { names: string[]; rows: string[][]; tags: Map<number, string[]> }) {
  const headingId = useId()
  return (
    <div>
      <h3 id={headingId} className="text-base font-semibold mb-2">Primeras filas del fichero</h3>
      {/* Región con foco: es la única forma de desplazar la tabla con el teclado. */}
      <div role="region" aria-labelledby={headingId} tabIndex={0}
        className="overflow-x-auto rounded-[var(--radius-panel)] border border-grid bg-sheet">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {names.map((name, i) => {
                const tag = tags.get(i)
                return (
                  <th key={i} scope="col" title={name} className={cx(
                    'px-3 py-2 text-left font-semibold align-top whitespace-nowrap max-w-[16rem] truncate border-b border-grid',
                    tag ? 'bg-needs-soft text-needs-ink' : 'text-ink',
                  )}>
                    {name}
                    {tag ? <span className="block text-xs font-medium">{tag.join(' y ')}</span> : null}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-b border-rule last:border-0">
                {names.map((_, i) => (
                  <td key={i} className={cx('px-3 py-2 whitespace-nowrap max-w-[16rem] truncate', tags.has(i) && 'bg-needs-soft/40')}>
                    {row[i] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
