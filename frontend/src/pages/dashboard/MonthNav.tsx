import { ChevronLeft, ChevronRight } from 'lucide-react'
import { currentMonth, shiftMonth } from '../../lib/dates'
import { capitalizeMonth } from './format'

/** Selector de mes: mes anterior / mes siguiente. No deja pasar del mes actual. */
export function MonthNav({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const isCurrentMonth = month >= currentMonth()
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="Mes anterior"
        onClick={() => onChange(shiftMonth(month, -1))}
        className="p-2 rounded-[var(--radius-control)] text-ink-soft hover:text-ink hover:bg-rule transition-colors"
      >
        <ChevronLeft size={20} aria-hidden />
      </button>
      <span className="min-w-[13ch] text-center text-[15px] font-medium">{capitalizeMonth(month)}</span>
      <button
        type="button"
        aria-label="Mes siguiente"
        onClick={() => onChange(shiftMonth(month, 1))}
        disabled={isCurrentMonth}
        className="p-2 rounded-[var(--radius-control)] text-ink-soft hover:text-ink hover:bg-rule transition-colors disabled:opacity-30 disabled:pointer-events-none"
      >
        <ChevronRight size={20} aria-hidden />
      </button>
    </div>
  )
}
