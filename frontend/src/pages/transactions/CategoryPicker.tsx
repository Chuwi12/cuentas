import { Circle } from 'lucide-react'
import { BUCKET_ORDER, BUCKETS } from '../../lib/buckets'
import { CategoryIcon } from '../../lib/icons'
import { cx } from '../../components/ui'
import type { Category, Kind } from '../../lib/types'

/**
 * Selector visual de categoría: rejilla de chips (role=radio), no un <select>
 * largo. Para gastos, agrupadas por cubo (needs/wants/savings); para
 * ingresos, en una sola fila. Incluye "Sin categoría" como opción explícita.
 */
export function CategoryPicker({ categories, kind, value, onChange, label }: {
  categories: Category[]
  kind: Kind
  value: string | null
  onChange: (id: string | null) => void
  label: string
}) {
  const options = categories.filter((c) => c.kind === kind && !c.is_archived)

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-ink">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Chip
            selected={value === null}
            onClick={() => onChange(null)}
            color={null}
            icon="circle"
            name="Sin categoría"
          />
          {kind === 'income' ? options.map((c) => (
            <Chip key={c.id} selected={value === c.id} onClick={() => onChange(c.id)}
              color={c.color} icon={c.icon} name={c.name} />
          )) : null}
        </div>
        {kind === 'expense' ? BUCKET_ORDER.map((bucket) => {
          const inBucket = options.filter((c) => c.bucket === bucket)
          if (inBucket.length === 0) return null
          return (
            <div key={bucket} className="flex flex-col gap-1.5">
              <span className={cx('text-xs font-medium', BUCKETS[bucket].text)}>{BUCKETS[bucket].label}</span>
              <div className="flex flex-wrap gap-2">
                {inBucket.map((c) => (
                  <Chip key={c.id} selected={value === c.id} onClick={() => onChange(c.id)}
                    color={c.color} icon={c.icon} name={c.name} />
                ))}
              </div>
            </div>
          )
        }) : null}
      </div>
    </div>
  )
}

function Chip({ selected, onClick, color, icon, name }: {
  selected: boolean; onClick: () => void; color: string | null; icon: string; name: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cx(
        'flex items-center gap-2 h-9 pl-2 pr-3 rounded-[var(--radius-control)] border text-sm font-medium transition-colors',
        selected ? 'border-ink bg-ink text-white' : 'border-grid bg-sheet text-ink hover:border-ink-faint',
      )}
    >
      <span
        className="flex items-center justify-center size-5 rounded-full"
        style={{ color: selected ? '#fff' : (color ?? 'var(--color-ink-faint)') }}
        aria-hidden
      >
        {icon === 'circle' && !color ? <Circle size={14} /> : <CategoryIcon name={icon} size={14} />}
      </span>
      {name}
    </button>
  )
}
