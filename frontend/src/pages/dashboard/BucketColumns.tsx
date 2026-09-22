import { Link } from 'react-router-dom'
import { CategoryIcon } from '../../lib/icons'
import { BUCKETS, BUCKET_ORDER } from '../../lib/buckets'
import { formatCents } from '../../lib/money'
import { cx, Money, RedPenNote } from '../../components/ui'
import { formatPct } from './format'
import type { Bucket, BucketSummary, MonthSummary } from '../../lib/types'

const COLUMN_BORDER: Record<Bucket, string> = {
  needs: 'border-needs',
  wants: 'border-wants',
  savings: 'border-savings',
}

/** Delta con signo, explicado en palabras. Para Ahorro, estar por encima es bueno. */
function deltaText(bucket: Bucket, deltaCents: number): { text: string; isOver: boolean } {
  if (bucket === 'savings') {
    if (deltaCents > 0) return { text: `${formatCents(deltaCents)} más de lo previsto`, isOver: false }
    if (deltaCents < 0) return { text: `Te faltan ${formatCents(-deltaCents)} para el objetivo`, isOver: false }
    return { text: 'Justo en el objetivo', isOver: false }
  }
  if (deltaCents > 0) return { text: `Te has pasado ${formatCents(deltaCents)}`, isOver: true }
  if (deltaCents < 0) return { text: `Te quedan ${formatCents(-deltaCents)}`, isOver: false }
  return { text: 'Justo en el objetivo', isOver: false }
}

/** Los tres cubos en detalle: una columna por cubo, con sus categorías. */
export function BucketColumns({ summary, hasIncome }: { summary: MonthSummary; hasIncome: boolean }) {
  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-rule border-t border-rule">
        {BUCKET_ORDER.map((key) => {
          const b = summary.buckets.find((x) => x.bucket === key) as BucketSummary
          const cats = summary.by_category
            .filter((c) => c.category.bucket === key)
            .sort((a, c) => c.amount_cents - a.amount_cents)
          const maxCat = cats.reduce((m, c) => Math.max(m, c.amount_cents), 0)
          const delta = deltaText(key, b.delta_cents)
          return (
            <div key={key} className={cx('pt-4 pb-6 px-1 md:px-6 md:first:pl-0 border-t-4', COLUMN_BORDER[key])}>
              <p className="text-lg font-semibold">{BUCKETS[key].label}</p>
              <p className="text-sm text-ink-soft">objetivo {b.target_pct} %</p>
              {key === 'savings' ? (
                <p className="text-sm text-ink-soft mt-1">Incluye lo invertido y el dinero no gastado este mes.</p>
              ) : null}

              {hasIncome ? (
                <>
                  <p className="mt-4 tabular">
                    {formatCents(b.actual_cents)} de {formatCents(b.target_cents)} previstos
                  </p>
                  <p className="text-sm text-ink-soft tabular">{formatPct(b.actual_pct)} del ingreso</p>
                  <p className="mt-1 text-sm">
                    {delta.isOver ? (
                      <RedPenNote>{delta.text}</RedPenNote>
                    ) : (
                      <span className="text-ink-soft">{delta.text}</span>
                    )}
                  </p>
                </>
              ) : (
                <p className="mt-4 tabular">{formatCents(b.actual_cents)} gastados</p>
              )}

              <ul className="mt-5 flex flex-col gap-3">
                {cats.map((c) => (
                  <li key={c.category.id}>
                    <div className="flex items-center gap-2 text-sm">
                      <CategoryIcon name={c.category.icon} size={16} className="text-ink-soft shrink-0" />
                      <span className="flex-1 truncate">{c.category.name}</span>
                      <Money cents={c.amount_cents} />
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-rule overflow-hidden">
                      <div
                        className={cx('h-full rounded-full', BUCKETS[key].bg)}
                        style={{ width: maxCat > 0 ? `${(c.amount_cents / maxCat) * 100}%` : '0%' }}
                      />
                    </div>
                  </li>
                ))}
                {cats.length === 0 ? <li className="text-sm text-ink-soft">Sin gastos este mes en este cubo.</li> : null}
              </ul>
            </div>
          )
        })}
      </div>

      {summary.uncategorized_expense_cents > 0 ? (
        <p className="mt-6 text-sm text-ink-soft">
          Hay <Money cents={summary.uncategorized_expense_cents} kind="expense" className="text-ink" /> en gastos sin
          categoría.{' '}
          <Link to="/movimientos" className="text-ink underline underline-offset-2 hover:text-needs">
            Asígnales una categoría en Movimientos
          </Link>
          .
        </p>
      ) : null}
    </div>
  )
}
