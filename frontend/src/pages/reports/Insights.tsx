import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { cx } from '../../components/ui'
import type { InsightLevel, ReportInsight } from '../../lib/types'

const STYLE: Record<InsightLevel, { box: string; icon: string; word: string; Icon: typeof Info }> = {
  good: { box: 'bg-savings-soft', icon: 'text-savings-ink', word: 'Bien', Icon: CheckCircle2 },
  info: { box: 'bg-needs-soft', icon: 'text-needs-ink', word: 'Nota', Icon: Info },
  warning: { box: 'bg-wants-soft', icon: 'text-wants-ink', word: 'Atención', Icon: AlertTriangle },
}

export function Insights({ items }: { items: ReportInsight[] }) {
  if (items.length === 0) return null
  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Análisis</h2>
      <ul className="flex flex-col gap-2">
        {items.map((i, idx) => {
          const s = STYLE[i.level] ?? STYLE.info
          return (
            <li key={`${i.code}-${idx}`} className={cx('flex items-start gap-3 rounded-[var(--radius-control)] px-3.5 py-3 text-[15px]', s.box)}>
              <s.Icon size={18} className={cx('mt-0.5 shrink-0', s.icon)} aria-hidden />
              <p><span className="sr-only">{s.word}: </span>{i.message}</p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
