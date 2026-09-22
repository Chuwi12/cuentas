import { BUCKETS, BUCKET_ORDER } from '../../lib/buckets'
import { formatCents } from '../../lib/money'
import { cx, RedPenNote } from '../../components/ui'
import type { Bucket, BucketSummary, MonthSummary } from '../../lib/types'

/**
 * EL REPARTO: una barra que representa el ingreso del mes, con marcas de
 * lápiz en 50 % y 80 % (fronteras 50/30/20) y los tres tramos realmente
 * destinados a cada cubo. Si un cubo se pasa de su objetivo, el exceso se
 * raya y se anota en rojo. Si el gasto total supera el ingreso, los tramos
 * desbordan la marca de "ingreso" y se avisa por texto.
 */
export function AllocationBar({ summary }: { summary: MonthSummary }) {
  const income = summary.income_cents
  const expense = summary.expense_cents
  const hasIncome = income > 0
  const overspentTotal = hasIncome && expense > income
  // La escala del dibujo es el mayor entre lo ingresado y lo gastado, para
  // que un mes con más gasto que ingreso se vea desbordar la barra en vez
  // de recortarse.
  const scale = Math.max(income, expense, 1)

  const segments = BUCKET_ORDER.reduce<
    { key: Bucket; b: BucketSummary; leftPct: number; widthPct: number; excessPct: number }[]
  >((acc, key) => {
    const b = summary.buckets.find((x) => x.bucket === key) as BucketSummary
    const widthPct = (b.actual_cents / scale) * 100
    const leftPct = acc.length > 0 ? acc[acc.length - 1].leftPct + acc[acc.length - 1].widthPct : 0
    const excessPct = key !== 'savings' && hasIncome && b.delta_cents > 0 ? (b.delta_cents / scale) * 100 : 0
    acc.push({ key, b, leftPct, widthPct, excessPct })
    return acc
  }, [])
  const overBuckets = segments.filter((s) => s.excessPct > 0)

  const ticks = hasIncome
    ? [
        { pct: ((income * 0.5) / scale) * 100, label: '50 %' },
        { pct: ((income * 0.8) / scale) * 100, label: '80 %' },
      ]
    : []
  const incomeMarkerPct = overspentTotal ? (income / scale) * 100 : null

  return (
    <div className="graph-paper rounded-[var(--radius-panel)] border border-grid p-5 md:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <div>
          <p className="text-sm text-ink-soft mb-1">Ingreso del mes</p>
          <p className="text-4xl md:text-5xl font-bold tabular tracking-[-0.02em]">{formatCents(income)}</p>
        </div>
        <div>
          <p className="text-sm text-ink-soft mb-1">Gastado</p>
          <p className="text-2xl md:text-3xl font-semibold tabular text-ink-soft">{formatCents(expense)}</p>
        </div>
      </div>

      {overspentTotal ? (
        <p className="mt-3 text-sm">
          Este mes has gastado más de lo que has ingresado.{' '}
          <RedPenNote>+{formatCents(expense - income)} por encima del ingreso</RedPenNote>
        </p>
      ) : null}
      {!hasIncome && expense > 0 ? (
        <p className="mt-3 text-sm text-ink-soft">
          No hay ingresos registrados este mes: no se puede calcular el reparto 50/30/20. Estos son los importes
          gastados por cada cubo.
        </p>
      ) : null}

      <div className="relative mt-10 pt-6">
        {ticks.map((t) => (
          <div key={t.label} className="absolute top-0 bottom-2" style={{ left: `${t.pct}%` }}>
            <span className="absolute -top-1 -translate-x-1/2 -rotate-2 font-hand text-lg text-ink-soft whitespace-nowrap">
              {t.label}
            </span>
            <span className="absolute top-6 bottom-0 -translate-x-1/2 border-l border-dashed border-ink-faint" />
          </div>
        ))}
        {incomeMarkerPct !== null ? (
          <div className="absolute top-0 bottom-2" style={{ left: `${incomeMarkerPct}%` }}>
            <span className="absolute -top-1 -translate-x-1/2 rotate-2 font-hand text-lg text-over whitespace-nowrap">
              ingreso
            </span>
            <span className="absolute top-6 bottom-0 -translate-x-1/2 border-l-2 border-over" />
          </div>
        ) : null}

        <div className="relative h-14 md:h-16 rounded-[4px] bg-rule overflow-hidden">
          {segments.map((s) =>
            s.widthPct > 0 ? (
              <div
                key={s.key}
                className={cx('absolute inset-y-0', BUCKETS[s.key].bg)}
                style={{ left: `${s.leftPct}%`, width: `${s.widthPct}%` }}
              />
            ) : null,
          )}
          {segments.map((s) =>
            s.excessPct > 0 ? (
              <div
                key={`${s.key}-excess`}
                className="absolute inset-y-0 pointer-events-none"
                style={{
                  left: `${s.leftPct + s.widthPct - s.excessPct}%`,
                  width: `${s.excessPct}%`,
                  backgroundImage: 'repeating-linear-gradient(135deg, var(--color-over) 0 3px, transparent 3px 7px)',
                  opacity: 0.6,
                }}
              />
            ) : null,
          )}
        </div>
      </div>

      <ul className="flex flex-wrap gap-x-6 gap-y-1.5 mt-4 text-sm text-ink-soft">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={cx('size-2.5 rounded-full', BUCKETS[s.key].bg)} aria-hidden />
            {BUCKETS[s.key].label} <span className="tabular text-ink">{formatCents(s.b.actual_cents)}</span>
          </li>
        ))}
      </ul>

      {overBuckets.length > 0 ? (
        <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3">
          {overBuckets.map((s: { key: Bucket; b: BucketSummary }) => (
            <p key={s.key} className="text-sm text-ink-soft">
              {BUCKETS[s.key].label}: <RedPenNote>+{formatCents(s.b.delta_cents)} sobre lo previsto</RedPenNote>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
