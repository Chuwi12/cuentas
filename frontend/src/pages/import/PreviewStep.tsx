import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleAlert, Copy } from 'lucide-react'
import { api, keys } from '../../lib/api'
import { BUCKET_ORDER, BUCKETS } from '../../lib/buckets'
import { formatDateNumeric } from '../../lib/dates'
import { Button, EmptyState, ErrorNote, Money, Select, Skeleton, cx } from '../../components/ui'
import type { Category, ImportPreview, ImportRow } from '../../lib/types'
import { DATE_FORMAT_NAME } from './mapping'
import { isSelectable, type Picks } from './selection'
import { StepHeading } from './Steps'

/** Filas que se pintan de golpe. Cada fila lleva un select: con 5.000 a la vez la página se arrastra. */
const FIRST_ROWS = 100
const MORE_ROWS = 200

const nf = new Intl.NumberFormat('es-ES')

interface CategoryOptions { income: ReactNode; expense: ReactNode }

/** Paso 3: revisar lo que se va a importar. Marca, desmarca y recategoriza antes de confirmar. */
export function PreviewStep({ preview, picks, setPicks, pending, error, focusHeading, onBack, onEditDateFormat, onConfirm }: {
  preview: ImportPreview
  picks: Picks
  setPicks: Dispatch<SetStateAction<Picks>>
  pending: boolean
  error: unknown
  focusHeading: boolean
  onBack: () => void
  /** Vuelve al mapeo, con el foco en el formato de fecha. */
  onEditDateFormat: () => void
  onConfirm: () => void
}) {
  const { rows, summary } = preview
  const categoriesQuery = useQuery({ queryKey: keys.categories(false), queryFn: () => api.categories.list(false) })
  const categories = categoriesQuery.data
  const [limit, setLimit] = useState(FIRST_ROWS)

  // Las opciones se construyen una vez y las comparten todas las filas.
  const options = useMemo<CategoryOptions | null>(() => {
    if (!categories) return null
    const active = categories.filter((c) => !c.is_archived)
    const option = (c: Category) => <option key={c.id} value={c.id}>{c.name}</option>
    const none = <option key="none" value="">Sin categoría</option>
    return {
      income: [none, ...active.filter((c) => c.kind === 'income').map(option)],
      expense: [none, ...BUCKET_ORDER.map((b) => {
        const inBucket = active.filter((c) => c.kind === 'expense' && c.bucket === b)
        return inBucket.length ? <optgroup key={b} label={BUCKETS[b].label}>{inBucket.map(option)}</optgroup> : null
      })],
    }
  }, [categories])

  const selectable = useMemo(() => rows.reduce((n, r) => n + (isSelectable(r) ? 1 : 0), 0), [rows])
  const included = selectable - picks.off.size

  const toggle = useCallback((index: number) => setPicks((p) => {
    const off = new Set(p.off)
    if (!off.delete(index)) off.add(index)
    return { ...p, off }
  }), [setPicks])

  const setCategory = useCallback((row: ImportRow, id: string | null) => setPicks((p) => {
    const cats = { ...p.cats }
    if (id === row.category_id) delete cats[row.index] // igual que la sugerida: no hace falta enviarla
    else cats[row.index] = id
    return { ...p, cats }
  }), [setPicks])

  const toggleAll = () => setPicks((p) => ({
    ...p,
    off: included === selectable ? new Set(rows.filter(isSelectable).map((r) => r.index)) : new Set(),
  }))

  const allRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  // Al fallar la importación el botón deshabilitado suelta el foco: se devuelve ahí, junto al aviso.
  useEffect(() => { if (error) confirmRef.current?.focus() }, [error])
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = included > 0 && included < selectable
  }, [included, selectable])

  const shown = rows.slice(0, limit)

  return (
    <section>
      <StepHeading focus={focusHeading}>Revisa antes de importar</StepHeading>
      <p className="text-ink-soft max-w-[68ch]">
        Las filas duplicadas y las que tienen error no se importan. Las categorías sugeridas salen de tus
        movimientos anteriores con la misma descripción.
      </p>

      <dl className="flex flex-wrap gap-x-8 gap-y-1 mt-5 mb-3 text-sm">
        <Stat label="Filas" value={summary.total} />
        <Stat label="Válidas" value={summary.valid} />
        <Stat label="Duplicadas" value={summary.duplicates} />
        <Stat label="Con error" value={summary.errors} warn={summary.errors > 0} />
      </dl>

      {/* Una fecha mal leída (día/mes cambiados) coloca el dinero en otro mes: se dice cómo se ha leído. */}
      <p className="flex flex-wrap items-center gap-x-2 mb-5 text-sm">
        <span>Fechas leídas como <span className="font-semibold">{DATE_FORMAT_NAME[preview.date_format]}</span>.</span>
        <Button variant="secondary" size="sm" onClick={onEditDateFormat} disabled={pending}>Cambiar formato de fecha</Button>
      </p>

      {rows.length === 0 ? (
        <EmptyState title="El fichero no tiene movimientos">
          Comprueba en el paso anterior si la primera fila es cabecera y vuelve a previsualizar.
        </EmptyState>
      ) : categoriesQuery.isError ? (
        <ErrorNote error={categoriesQuery.error} onRetry={() => categoriesQuery.refetch()} />
      ) : !options ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      ) : (
        <>
          {selectable > 0 ? (
            <label className="inline-flex items-center gap-3 min-h-10 mb-2 cursor-pointer text-[15px] font-medium">
              <input
                ref={allRef}
                type="checkbox"
                checked={included === selectable}
                onChange={toggleAll}
                className="size-5 cursor-pointer accent-ink"
              />
              Incluir todas las filas nuevas
            </label>
          ) : null}

          {/* Pasado el breakpoint lg es una tabla; antes, cada fila pasa a tarjeta. Los roles explícitos
              mantienen la semántica de tabla cuando CSS cambia el display. */}
          <table role="table" className="w-full table-fixed text-[15px] border-t border-grid max-lg:block">
            <caption className="sr-only">Movimientos del fichero</caption>
            <thead role="rowgroup" className="max-lg:sr-only">
              <tr role="row" className="border-b border-grid text-left text-sm text-ink-soft">
                <th role="columnheader" scope="col" className="w-12 px-1 py-2 font-medium"><span className="sr-only">Incluir</span></th>
                <th role="columnheader" scope="col" className="w-28 px-3 py-2 font-medium">Fecha</th>
                <th role="columnheader" scope="col" className="px-3 py-2 font-medium">Descripción</th>
                <th role="columnheader" scope="col" className="w-72 px-3 py-2 font-medium">Categoría</th>
                <th role="columnheader" scope="col" className="w-32 px-3 py-2 font-medium text-right">Importe</th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="max-lg:block">
              {shown.map((row) => (
                <PreviewRow
                  key={row.index}
                  row={row}
                  checked={isSelectable(row) && !picks.off.has(row.index)}
                  categoryId={row.index in picks.cats ? picks.cats[row.index] : row.category_id}
                  options={options}
                  onToggle={toggle}
                  onCategory={setCategory}
                />
              ))}
            </tbody>
          </table>

          {rows.length > limit ? (
            <div className="flex flex-wrap items-center gap-3 mt-4">
              <p className="text-sm text-ink-soft">Mostrando {nf.format(limit)} de {nf.format(rows.length)} filas.</p>
              <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + MORE_ROWS)}>
                Mostrar {nf.format(Math.min(MORE_ROWS, rows.length - limit))} más
              </Button>
            </div>
          ) : null}
        </>
      )}

      {error ? <div className="mt-4"><ErrorNote error={error} /></div> : null}

      <div className={cx(
        'sticky z-10 mt-6 -mx-4 px-4 py-3 bg-sheet border-t border-grid',
        'bottom-[calc(4rem+env(safe-area-inset-bottom))] md:bottom-4 md:mx-0 md:border md:rounded-[var(--radius-panel)] md:shadow-[var(--shadow-lift)]',
        'flex flex-wrap items-center justify-between gap-x-6 gap-y-2',
      )}>
        <p className="text-sm text-ink-soft">
          {selectable === 0
            ? 'No hay filas nuevas que importar.'
            : <><span className="font-semibold text-ink tabular">{nf.format(included)}</span> de {nf.format(selectable)} filas nuevas incluidas</>}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onBack} disabled={pending}>Atrás</Button>
          <Button ref={confirmRef} onClick={onConfirm} loading={pending} disabled={included === 0}>
            Importar {nf.format(included)} {included === 1 ? 'movimiento' : 'movimientos'}
          </Button>
        </div>
      </div>
    </section>
  )
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={cx('text-base font-semibold tabular', warn && 'text-over')}>{nf.format(value)}</dd>
    </div>
  )
}

/** Una fila memoizada: marcar o recategorizar una no repinta las demás. */
const PreviewRow = memo(function PreviewRow({ row, checked, categoryId, options, onToggle, onCategory }: {
  row: ImportRow
  checked: boolean
  categoryId: string | null
  options: CategoryOptions
  onToggle: (index: number) => void
  onCategory: (row: ImportRow, id: string | null) => void
}) {
  const selectable = isSelectable(row)
  const label = row.description || `fila ${row.index + 1}`
  const suggested = selectable && row.category_id !== null && categoryId === row.category_id

  return (
    <tr
      role="row"
      className={cx(
        'border-b border-rule align-top',
        'max-lg:grid max-lg:grid-cols-[2.5rem_minmax(0,1fr)_auto] max-lg:gap-x-2 max-lg:py-3',
        row.error && 'bg-over-soft/40',
        row.duplicate && !row.error && 'text-ink-soft',
      )}
    >
      <td role="cell" className="px-1 py-1.5 max-lg:col-start-1 max-lg:row-start-1 max-lg:p-0">
        <label className={cx('flex size-10 items-center justify-center', selectable ? 'cursor-pointer' : 'cursor-not-allowed')}>
          <input
            type="checkbox"
            checked={checked}
            disabled={!selectable}
            onChange={() => onToggle(row.index)}
            aria-label={`Incluir ${label}`}
            className="size-5 accent-ink disabled:cursor-not-allowed"
          />
        </label>
      </td>

      <td role="cell" className={cx(
        'px-3 pt-3.5 pb-2.5 whitespace-nowrap tabular max-lg:col-start-2 max-lg:col-end-4 max-lg:row-start-2 max-lg:p-0 max-lg:text-sm max-lg:text-ink-soft',
        !row.occurred_on && 'max-lg:hidden',
      )}>
        {row.occurred_on ? formatDateNumeric(row.occurred_on) : '—'}
      </td>

      <td role="cell" className="px-3 pt-3.5 pb-2.5 max-lg:col-start-2 max-lg:row-start-1 max-lg:p-0 max-lg:pt-2">
        <p className={cx('line-clamp-2 break-words', !row.description && 'italic text-ink-soft')}>
          {row.description || 'Sin descripción'}
        </p>
        {row.error ? (
          <p className="mt-1 flex items-start gap-1.5 text-sm text-over">
            <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
            <span>Error: {row.error}</span>
          </p>
        ) : row.duplicate ? (
          <p className="mt-1 flex items-start gap-1.5 text-sm text-ink-soft">
            <Copy size={15} className="mt-0.5 shrink-0" aria-hidden />
            <span>Duplicada: ya importada</span>
          </p>
        ) : null}
      </td>

      <td role="cell" className={cx(
        'px-3 py-1.5 max-lg:col-start-2 max-lg:col-end-4 max-lg:row-start-3 max-lg:p-0 max-lg:pt-2',
        !(selectable && row.kind) && 'max-lg:hidden', // sin select, en tarjeta no hay nada que enseñar
      )}>
        {selectable && row.kind ? (
          <div className="flex items-center gap-2">
            <Select
              aria-label={`Categoría de ${label}`}
              value={categoryId ?? ''}
              onChange={(e) => onCategory(row, e.target.value || null)}
              className="min-w-0 max-lg:flex-1 lg:w-[11.5rem] lg:flex-none"
            >
              {row.kind === 'income' ? options.income : options.expense}
            </Select>
            {suggested ? <span className="shrink-0 h-5 px-1.5 rounded bg-rule text-xs leading-5 text-ink-soft">sugerida</span> : null}
          </div>
        ) : <span className="block leading-10 text-ink-faint max-lg:leading-normal">—</span>}
      </td>

      <td role="cell" className="px-3 pt-3.5 pb-2.5 text-right max-lg:col-start-3 max-lg:row-start-1 max-lg:p-0 max-lg:pt-2">
        {row.amount_cents !== null
          ? <Money cents={row.amount_cents} kind={row.kind ?? undefined} className="font-medium" />
          : '—'}
      </td>
    </tr>
  )
})
