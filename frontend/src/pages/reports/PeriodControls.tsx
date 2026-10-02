import { ChevronLeft, ChevronRight } from 'lucide-react'
import { capitalize, formatPeriodLabel, periodRange, shiftPeriod, todayISO } from '../../lib/dates'
import { Segmented } from '../../components/ui'
import type { ReportPeriodKind, ReportScope } from '../../lib/types'
import { PERIOD_OPTIONS, SCOPE_OPTIONS } from './labels'

const PREV_NEXT: Record<ReportPeriodKind, [string, string]> = {
  week: ['Semana anterior', 'Semana siguiente'],
  month: ['Mes anterior', 'Mes siguiente'],
  year: ['Año anterior', 'Año siguiente'],
}

const navButton =
  'p-2 rounded-[var(--radius-control)] text-ink-soft hover:text-ink hover:bg-rule transition-colors ' +
  'disabled:opacity-30 disabled:pointer-events-none'

/** Periodo (semana / mes / año), navegación entre periodos y alcance. */
export function PeriodControls({ kind, date, scope, onKind, onDate, onScope }: {
  kind: ReportPeriodKind
  date: string
  scope: ReportScope
  onKind: (k: ReportPeriodKind) => void
  onDate: (d: string) => void
  onScope: (s: ReportScope) => void
}) {
  const { from, to } = periodRange(kind, date)
  const isCurrent = to >= todayISO()
  const [prevLabel, nextLabel] = PREV_NEXT[kind]
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 mb-8">
      <Segmented label="Periodo" value={kind} onChange={onKind} options={PERIOD_OPTIONS} />

      <div className="inline-flex items-center gap-1">
        <button type="button" aria-label={prevLabel} onClick={() => onDate(shiftPeriod(kind, date, -1))} className={navButton}>
          <ChevronLeft size={20} aria-hidden />
        </button>
        <span aria-live="polite" className="min-w-[12ch] text-center text-[15px] font-medium">
          {capitalize(formatPeriodLabel(kind, from, to))}
        </span>
        <button type="button" aria-label={nextLabel} onClick={() => onDate(shiftPeriod(kind, date, 1))} disabled={isCurrent} className={navButton}>
          <ChevronRight size={20} aria-hidden />
        </button>
      </div>

      <Segmented label="Alcance" value={scope} onChange={onScope} options={SCOPE_OPTIONS} />
    </div>
  )
}
