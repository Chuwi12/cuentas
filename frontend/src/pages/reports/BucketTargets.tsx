import { BUCKETS } from '../../lib/buckets'
import { formatCents, formatPct } from '../../lib/money'
import { cx, RedPenNote } from '../../components/ui'
import type { ReportBucketRow } from '../../lib/types'

/** Gasto por cubo frente a su objetivo 50/30/20 sobre los ingresos del periodo. */
export function BucketTargets({ rows }: { rows: ReportBucketRow[] }) {
  const noIncome = rows.every((r) => r.target_cents === null)
  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">Reparto por cubos</h2>
      <p className="text-sm text-ink-soft mb-4">
        {noIncome ? 'Sin ingresos en el periodo: no hay objetivo con el que comparar.' : 'Gasto frente al objetivo 50/30/20 sobre los ingresos.'}
      </p>
      <ul className="flex flex-col gap-4">
        {rows.map((r) => {
          const meta = r.bucket ? BUCKETS[r.bucket] : null
          const label = meta?.label ?? 'Sin cubo'
          const target = r.target_cents
          const over = target !== null && (r.bucket === 'needs' || r.bucket === 'wants') && r.amount_cents > target
          const scale = Math.max(r.amount_cents, target ?? 0)
          const pct = (v: number) => (scale > 0 ? `${(v / scale) * 100}%` : '0%')
          return (
            <li key={r.bucket ?? 'none'}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="font-medium">
                  {label}
                  {meta ? <span className="font-normal text-ink-soft"> · objetivo {meta.pct} %</span> : null}
                </span>
                <span className="tabular">
                  {formatCents(r.amount_cents)}
                  {target !== null ? <span className="text-ink-soft"> de {formatCents(target)}</span> : null}
                </span>
              </div>
              <div className="relative mt-1.5 h-2 rounded-full bg-rule overflow-hidden" aria-hidden>
                <div
                  className={cx('h-full rounded-full', over ? 'bg-over' : meta?.bg ?? 'bg-ink-faint')}
                  style={{ width: pct(r.amount_cents) }}
                />
              </div>
              {target !== null ? (
                <div className="relative h-2 -mt-2 pointer-events-none" aria-hidden>
                  <span className="absolute top-0 h-2 w-0.5 bg-ink" style={{ left: pct(target) }} />
                </div>
              ) : null}
              <p className="mt-1 text-sm text-ink-soft tabular">
                {r.income_share_bp === null ? 'Sin ingresos con los que comparar' : `${formatPct(r.income_share_bp / 100)} de los ingresos`}
                {over ? <> {' · '}<RedPenNote className="text-base">Te has pasado {formatCents(r.amount_cents - (target as number))}</RedPenNote></> : null}
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
