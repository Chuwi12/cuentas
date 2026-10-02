import { formatCents, formatPct } from '../../lib/money'
import { cx } from '../../components/ui'
import type { ReportTotals } from '../../lib/types'
import { pctChange } from './labels'

function Delta({ text, good }: { text: string; good: boolean | null }) {
  return (
    <p className={cx('text-sm tabular', good === null ? 'text-ink-soft' : good ? 'text-income' : 'text-over')}>
      {text}
    </p>
  )
}

function moneyDelta(cur: number, prev: number, higherIsBetter: boolean) {
  const c = pctChange(cur, prev)
  if (c === null) return <Delta text="Sin datos del periodo anterior" good={null} />
  if (Math.abs(c) < 0.05) return <Delta text="Igual que el periodo anterior" good={null} />
  return <Delta text={`${c > 0 ? '+' : ''}${formatPct(c)} vs. periodo anterior`} good={c > 0 === higherIsBetter} />
}

function rateDelta(cur: number | null, prev: number | null) {
  if (cur === null || prev === null) return <Delta text="Sin datos del periodo anterior" good={null} />
  const d = (cur - prev) / 100
  if (Math.abs(d) < 0.05) return <Delta text="Igual que el periodo anterior" good={null} />
  return <Delta text={`${d > 0 ? '+' : ''}${d.toFixed(1).replace('.', ',')} pp vs. periodo anterior`} good={d > 0} />
}

function Card({ title, value, valueClass, children }: {
  title: string; value: string; valueClass?: string; children: React.ReactNode
}) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-grid bg-sheet p-4">
      <p className="text-sm text-ink-soft">{title}</p>
      <p className={cx('mt-1 text-2xl font-bold tabular', valueClass)}>{value}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

/** Totales del periodo con su variación frente al anterior. Siempre incluyen
 *  ingresos y gastos, sea cual sea el alcance elegido. */
export function KpiCards({ totals, previous }: { totals: ReportTotals; previous: ReportTotals }) {
  return (
    <section aria-label="Totales del periodo" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <Card title="Ingresos" value={formatCents(totals.income_cents)}>
        {moneyDelta(totals.income_cents, previous.income_cents, true)}
      </Card>
      <Card title="Gastos" value={formatCents(totals.expense_cents)}>
        {moneyDelta(totals.expense_cents, previous.expense_cents, false)}
      </Card>
      <Card title="Neto" value={formatCents(totals.net_cents)} valueClass={totals.net_cents < 0 ? 'text-over' : undefined}>
        {moneyDelta(totals.net_cents, previous.net_cents, true)}
      </Card>
      <Card
        title="Tasa de ahorro"
        value={totals.savings_rate_bp === null ? 'Sin ingresos' : formatPct(totals.savings_rate_bp / 100)}
      >
        {rateDelta(totals.savings_rate_bp, previous.savings_rate_bp)}
      </Card>
    </section>
  )
}
