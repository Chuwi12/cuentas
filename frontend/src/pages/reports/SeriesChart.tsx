import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDay, formatMonthShort, formatMonthTitle, formatWeekdayShort } from '../../lib/dates'
import { formatCents, formatCentsRound } from '../../lib/money'
import type { ReportPeriodKind, ReportScope, ReportSeriesPoint } from '../../lib/types'

// Ingreso en el verde de texto de ingreso y gasto en tinta: no son cubos.
const INCOME_COLOR = '#157761'
const EXPENSE_COLOR = '#1C2B3A'

function tick(kind: ReportPeriodKind, from: string): string {
  if (kind === 'year') return formatMonthShort(from.slice(0, 7))
  if (kind === 'month') return String(Number(from.slice(8, 10)))
  return `${formatWeekdayShort(from)} ${Number(from.slice(8, 10))}`
}

function title(kind: ReportPeriodKind, from: string): string {
  return kind === 'year' ? formatMonthTitle(from.slice(0, 7)) : formatDay(from)
}

function SeriesTooltip({ active, payload, kind }: {
  active?: boolean
  payload?: { payload?: ReportSeriesPoint }[]
  kind: ReportPeriodKind
}) {
  const p = payload?.[0]?.payload
  if (!active || !p) return null
  return (
    <div className="rounded-[var(--radius-control)] border border-grid bg-sheet px-3 py-2 text-sm shadow-[var(--shadow-lift)]">
      <p className="font-medium mb-1">{title(kind, p.from)}</p>
      <dl className="flex flex-col gap-0.5">
        <div className="flex justify-between gap-4"><dt className="text-ink-soft">Ingresos</dt><dd className="tabular">{formatCents(p.income_cents)}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-ink-soft">Gastos</dt><dd className="tabular">{formatCents(p.expense_cents)}</dd></div>
      </dl>
    </div>
  )
}

/** Ingresos y gastos por día (semana, mes) o por mes (año), según el alcance. */
export function SeriesChart({ series, kind, scope }: {
  series: ReportSeriesPoint[]; kind: ReportPeriodKind; scope: ReportScope
}) {
  const showIncome = scope !== 'expenses'
  const showExpense = scope !== 'income'
  // recharts anima por JS: la regla CSS de prefers-reduced-motion no le afecta.
  const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const heading = kind === 'year' ? 'Evolución por mes' : 'Evolución por día'
  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">{heading}</h2>
      <div className="h-64 md:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke="var(--color-rule)" />
            <XAxis
              dataKey="from"
              tickFormatter={(v: string) => tick(kind, v)}
              interval={kind === 'month' ? 'preserveStartEnd' : 0}
              minTickGap={8}
              tick={{ fill: 'var(--color-ink-soft)', fontSize: 12 }}
              axisLine={{ stroke: 'var(--color-grid)' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => formatCentsRound(v)}
              tick={{ fill: 'var(--color-ink-soft)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            <Tooltip content={<SeriesTooltip kind={kind} />} cursor={{ fill: 'var(--color-rule)' }} />
            {showIncome ? <Bar isAnimationActive={animate} dataKey="income_cents" name="Ingresos" fill={INCOME_COLOR} radius={[2, 2, 0, 0]} /> : null}
            {showExpense ? <Bar isAnimationActive={animate} dataKey="expense_cents" name="Gastos" fill={EXPENSE_COLOR} radius={[2, 2, 0, 0]} /> : null}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ul className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-sm text-ink-soft">
        {showIncome ? <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: INCOME_COLOR }} aria-hidden />Ingresos</li> : null}
        {showExpense ? <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: EXPENSE_COLOR }} aria-hidden />Gastos</li> : null}
      </ul>

      <details className="mt-4">
        <summary className="text-sm text-ink-soft cursor-pointer select-none w-fit">Ver como tabla</summary>
        <div className="mt-2 overflow-x-auto max-h-80">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-rule text-left text-ink-soft">
                <th scope="col" className="py-1.5 pr-3 font-medium">{kind === 'year' ? 'Mes' : 'Día'}</th>
                {showIncome ? <th scope="col" className="py-1.5 pr-3 font-medium text-right">Ingresos</th> : null}
                {showExpense ? <th scope="col" className="py-1.5 font-medium text-right">Gastos</th> : null}
              </tr>
            </thead>
            <tbody>
              {series.map((p) => (
                <tr key={p.from} className="border-b border-rule last:border-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">{title(kind, p.from)}</th>
                  {showIncome ? <td className="py-1.5 pr-3 tabular text-right">{formatCents(p.income_cents)}</td> : null}
                  {showExpense ? <td className="py-1.5 tabular text-right">{formatCents(p.expense_cents)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
