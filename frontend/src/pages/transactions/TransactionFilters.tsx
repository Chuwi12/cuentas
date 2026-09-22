import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { BUCKET_ORDER, BUCKETS } from '../../lib/buckets'
import { formatMonth, shiftMonth } from '../../lib/dates'
import { Button, Segmented, Select, TextInput } from '../../components/ui'
import type { Bucket, Category, Kind } from '../../lib/types'

type KindFilter = Kind | 'all'

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'expense', label: 'Gastos' },
  { value: 'income', label: 'Ingresos' },
]

export function TransactionFilters({
  month, onMonthChange,
  kind, onKindChange,
  bucket, onBucketChange,
  categoryId, onCategoryChange,
  search, onSearchChange,
  categories,
}: {
  month: string
  onMonthChange: (month: string) => void
  kind: KindFilter
  onKindChange: (k: KindFilter) => void
  bucket: Bucket | 'all'
  onBucketChange: (b: Bucket | 'all') => void
  categoryId: string | 'all'
  onCategoryChange: (id: string | 'all') => void
  search: string
  onSearchChange: (q: string) => void
  categories: Category[]
}) {
  const categoryOptions = categories.filter((c) => {
    if (kind !== 'all' && c.kind !== kind) return false
    if (bucket !== 'all' && c.bucket !== bucket) return false
    return true
  })

  return (
    <div className="flex flex-wrap items-end gap-4 mb-5">
      <FilterGroup label="Mes">
        <div className="flex items-center gap-1 h-10">
          <Button type="button" variant="ghost" size="sm" aria-label="Mes anterior"
            onClick={() => onMonthChange(shiftMonth(month, -1))}>
            <ChevronLeft size={18} />
          </Button>
          <span className="min-w-[12ch] text-center text-[15px] font-medium capitalize">{formatMonth(month)}</span>
          <Button type="button" variant="ghost" size="sm" aria-label="Mes siguiente"
            onClick={() => onMonthChange(shiftMonth(month, 1))}>
            <ChevronRight size={18} />
          </Button>
        </div>
      </FilterGroup>

      <FilterGroup label="Tipo">
        <Segmented value={kind} onChange={onKindChange} label="Tipo de movimiento" options={KIND_OPTIONS} />
      </FilterGroup>

      <FilterGroup label="Cubo">
        <Select
          aria-label="Cubo"
          disabled={kind === 'income'}
          value={bucket}
          onChange={(e) => onBucketChange(e.target.value as Bucket | 'all')}
          className="disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value="all">Todos los cubos</option>
          {BUCKET_ORDER.map((b) => <option key={b} value={b}>{BUCKETS[b].label}</option>)}
        </Select>
      </FilterGroup>

      <FilterGroup label="Categoría">
        <Select
          aria-label="Categoría"
          value={categoryId}
          onChange={(e) => onCategoryChange(e.target.value)}
          className="w-56"
        >
          <option value="all">Todas las categorías</option>
          {categoryOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </FilterGroup>

      <FilterGroup label="Buscar" className="flex-1 min-w-[14rem]">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" aria-hidden />
          <TextInput
            aria-label="Buscar movimientos"
            placeholder="Descripción o categoría…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>
      </FilterGroup>
    </div>
  )
}

function FilterGroup({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <span className="text-sm font-medium text-ink-soft">{label}</span>
      {children}
    </div>
  )
}
