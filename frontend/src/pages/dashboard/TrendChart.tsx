import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { BUCKETS, BUCKET_ORDER } from '../../lib/buckets'
import { formatMonthShort, formatMonthTitle } from '../../lib/dates'
import { formatCents, formatCentsRound } from '../../lib/money'
import { cx } from '../../components/ui'

import type { TrendPoint } from '../../lib/types'

// --color-ink de app.css: la línea de ingreso usa la tinta del cuaderno, no
// un color de cubo (el ingreso no es un cubo).
const INCOME_COLOR = '#1C2B3A'

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: { dataKey?: string | number; value?: number }[]
  label?: string
}) {
  if (!active || !payload || payload.length === 0 || !label) return null
  const byKey = new Map(payload.map((p) => [String(p.dataKey), p.value ?? 0]))
  return (
    <div className="rounded-[var(--radius-control)] border border-grid bg-sheet px-3 py-2 text-sm shadow-[var(--shadow-lift)]">
      <p className="font-medium mb-1">{formatMonthTitle(label)}</p>
      <dl className="flex flex-col gap-0.5">
        {BUCKET_ORDER.map((key) => (
          <div key={key} className="flex items-center justify-between gap-4">
            <dt className="flex items-center gap-1.5 text-ink-soft">
              <span className={cx('size-2 rounded-full', BUCKETS[key].bg)} aria-hidden />
              {BUCKETS[key].label}
            </dt>
            <dd className="tabular">{formatCents(byKey.get(`${key}_cents`) ?? 0)}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 pt-1 mt-1 border-t border-rule">
          <dt className="text-ink-soft">Ingreso</dt>
          <dd className="tabular">{formatCents(byKey.get('income_cents') ?? 0)}</dd>
        </div>
      </dl>
    </div>
  )
}

/** Evolución de los últimos meses: barras apiladas needs/wants/savings + línea de ingreso. */
export function TrendChart({ points: allPoints }: { points: TrendPoint[] }) {
  // Los meses anteriores al primer movimiento no son "0 € de ingreso": es que
  // aún no usabas la app. Dibujarlos como 0 inventaría una caída que no existió.
  const first = allPoints.findIndex((p) => p.income_cents + p.needs_cents + p.wants_cents + p.savings_cents > 0)
  const points = first === -1 ? allPoints : allPoints.slice(first)
  // recharts anima por JS: la regla CSS de prefers-reduced-motion no le afecta.
  const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">Evolución</h2>
      <p className="text-sm text-ink-soft mb-4">{points.length === 1 ? 'Este mes' : `Últimos ${points.length} meses`}</p>

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="24%">
            <CartesianGrid vertical={false} stroke="var(--color-rule)" />
            <XAxis
              dataKey="month"
              tickFormatter={(m: string) => formatMonthShort(m)}
              tick={{ fill: 'var(--color-ink-soft)', fontSize: 12 }}
              axisLine={{ stroke: 'var(--color-grid)' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => formatCentsRound(v)}
              tick={{ fill: 'var(--color-ink-soft)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={60}
            />
            <Tooltip content={<TrendTooltip />} cursor={{ fill: 'var(--color-rule)' }} />
            <Bar isAnimationActive={animate} dataKey="needs_cents" name="Necesidades" stackId="gastos" fill={BUCKETS.needs.hex} />
            <Bar isAnimationActive={animate} dataKey="wants_cents" name="Deseos" stackId="gastos" fill={BUCKETS.wants.hex} />
            <Bar isAnimationActive={animate} dataKey="savings_cents" name="Ahorro" stackId="gastos" fill={BUCKETS.savings.hex} radius={[3, 3, 0, 0]} />
            <Line
              isAnimationActive={animate}
              dataKey="income_cents"
              name="Ingreso"
              stroke={INCOME_COLOR}
              strokeWidth={2}
              dot={{ r: 3, fill: INCOME_COLOR, strokeWidth: 0 }}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <ul className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-sm text-ink-soft">
        {BUCKET_ORDER.map((key) => (
          <li key={key} className="flex items-center gap-1.5">
            <span className={cx('size-2.5 rounded-full', BUCKETS[key].bg)} aria-hidden />
            {BUCKETS[key].label}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 bg-ink" aria-hidden />
          Ingreso
        </li>
      </ul>

      <details className="mt-4">
        <summary className="text-sm text-ink-soft cursor-pointer select-none w-fit">Ver como tabla</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-rule text-left text-ink-soft">
                <th className="py-1.5 pr-3 font-medium">Mes</th>
                <th className="py-1.5 pr-3 font-medium">Ingreso</th>
                <th className="py-1.5 pr-3 font-medium">Necesidades</th>
                <th className="py-1.5 pr-3 font-medium">Deseos</th>
                <th className="py-1.5 font-medium">Ahorro</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.month} className="border-b border-rule last:border-0">
                  <td className="py-1.5 pr-3">{formatMonthTitle(p.month)}</td>
                  <td className="py-1.5 pr-3 tabular">{formatCents(p.income_cents)}</td>
                  <td className="py-1.5 pr-3 tabular">{formatCents(p.needs_cents)}</td>
                  <td className="py-1.5 pr-3 tabular">{formatCents(p.wants_cents)}</td>
                  <td className="py-1.5 tabular">{formatCents(p.savings_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
