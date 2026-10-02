import { formatCents, formatPct } from '../../lib/money'
import { BucketTag } from '../../components/ui'
import type { ReportCategoryRow, ReportScope } from '../../lib/types'
import { categoryKindFor, KIND_LABEL } from './labels'

const MAX_BARS = 8

/** Barras horizontales con el color de cada categoría (las cifras van siempre en texto). */
export function CategoryChart({ rows, scope }: { rows: ReportCategoryRow[]; scope: ReportScope }) {
  const kind = categoryKindFor(scope)
  const list = rows.filter((r) => r.kind === kind)
  const top = list.slice(0, MAX_BARS)
  const max = top[0]?.amount_cents ?? 0
  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">{kind === 'income' ? 'Ingresos' : 'Gastos'} por categoría</h2>
      {top.length === 0 ? (
        <p className="text-sm text-ink-soft">Sin movimientos de este tipo en el periodo.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {top.map((c) => (
            <li key={c.category_id ?? 'none'}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate">{c.name}</span>
                <span className="tabular whitespace-nowrap">
                  {formatCents(c.amount_cents)} <span className="text-ink-soft">· {formatPct(c.share_bp / 100)}</span>
                </span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-rule overflow-hidden" aria-hidden>
                <div
                  className="h-full rounded-full"
                  style={{ width: max > 0 ? `${Math.max((c.amount_cents / max) * 100, 1.5)}%` : '0%', background: c.color }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.length > top.length ? (
        <p className="mt-3 text-sm text-ink-soft">Las {top.length} mayores de {list.length}. El resto, en la tabla.</p>
      ) : null}
    </section>
  )
}

export function CategoryTable({ rows }: { rows: ReportCategoryRow[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Categorías</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-grid text-left text-ink-soft">
              <th scope="col" className="py-2 pr-3 font-medium">Categoría</th>
              <th scope="col" className="py-2 pr-3 font-medium">Tipo</th>
              <th scope="col" className="py-2 pr-3 font-medium text-right">Mov.</th>
              <th scope="col" className="py-2 pr-3 font-medium text-right">Importe</th>
              <th scope="col" className="py-2 font-medium text-right">%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={`${c.kind}-${c.category_id ?? 'none'}`} className="border-b border-rule last:border-0">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full shrink-0" style={{ background: c.color }} aria-hidden />
                    <span>{c.name}</span>
                    {c.bucket ? <BucketTag bucket={c.bucket} /> : null}
                  </span>
                </th>
                <td className="py-2 pr-3 text-ink-soft">{KIND_LABEL[c.kind]}</td>
                <td className="py-2 pr-3 tabular text-right">{c.count}</td>
                <td className="py-2 pr-3 tabular text-right whitespace-nowrap">{formatCents(c.amount_cents)}</td>
                <td className="py-2 tabular text-right whitespace-nowrap">{formatPct(c.share_bp / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
