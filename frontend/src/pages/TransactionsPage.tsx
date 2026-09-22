import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { api, keys } from '../lib/api'
import { currentMonth, monthRange } from '../lib/dates'
import { Button, PageHeader } from '../components/ui'
import { TransactionFilters } from './transactions/TransactionFilters'
import { TransactionList } from './transactions/TransactionList'
import { TransactionDialog } from './transactions/TransactionDialog'
import { useDebouncedValue } from './transactions/useDebouncedValue'
import type { Bucket, Kind, Transaction } from '../lib/types'

type KindFilter = Kind | 'all'
type DialogState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; transaction: Transaction }

export default function TransactionsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const month = searchParams.get('mes') ?? currentMonth()

  const [kind, setKind] = useState<KindFilter>('all')
  const [bucket, setBucket] = useState<Bucket | 'all'>('all')
  const [categoryId, setCategoryId] = useState<string | 'all'>('all')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 300)

  const [dialog, setDialog] = useState<DialogState>({ mode: 'closed' })
  const [flash, setFlash] = useState<string | null>(null)

  const categoriesQuery = useQuery({ queryKey: keys.categories(false), queryFn: () => api.categories.list(false) })
  const categories = categoriesQuery.data ?? []

  // ?nuevo=1 (enlace desde el Resumen) abre el alta al entrar y limpia la URL.
  useEffect(() => {
    if (searchParams.get('nuevo') === '1') {
      setDialog({ mode: 'create' })
      const next = new URLSearchParams(searchParams)
      next.delete('nuevo')
      setSearchParams(next, { replace: true })
    }
    // Solo al montar: consumimos el parámetro una vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 3000)
    return () => clearTimeout(t)
  }, [flash])

  function setMonth(next: string) {
    const params = new URLSearchParams(searchParams)
    params.set('mes', next)
    setSearchParams(params)
  }

  function handleKindChange(next: KindFilter) {
    setKind(next)
    if (next === 'income') setBucket('all')
  }

  function clearFilters() {
    setKind('all')
    setBucket('all')
    setCategoryId('all')
    setSearch('')
  }

  const hasActiveFilters = kind !== 'all' || bucket !== 'all' || categoryId !== 'all' || search.trim() !== ''

  const { from, to } = monthRange(month)
  const listFilters = {
    from,
    to,
    kind: kind === 'all' ? undefined : kind,
    bucket: bucket === 'all' ? undefined : bucket,
    category_id: categoryId === 'all' ? undefined : categoryId,
    q: debouncedSearch.trim() || undefined,
  }

  return (
    <div>
      <PageHeader title="Movimientos">
        <div className="hidden md:block">
          <Button onClick={() => setDialog({ mode: 'create' })}>
            <Plus size={18} aria-hidden />Añadir movimiento
          </Button>
        </div>
      </PageHeader>

      {flash ? (
        <div role="status" className="mb-4 inline-flex items-center h-9 px-3 rounded-[var(--radius-control)] bg-savings-soft text-savings-ink text-sm font-medium">
          {flash}
        </div>
      ) : null}

      <TransactionFilters
        month={month}
        onMonthChange={setMonth}
        kind={kind}
        onKindChange={handleKindChange}
        bucket={bucket}
        onBucketChange={setBucket}
        categoryId={categoryId}
        onCategoryChange={setCategoryId}
        search={search}
        onSearchChange={setSearch}
        categories={categories}
      />

      <TransactionList
        month={month}
        filters={listFilters}
        hasActiveFilters={hasActiveFilters}
        onEdit={(tx) => setDialog({ mode: 'edit', transaction: tx })}
        onAdd={() => setDialog({ mode: 'create' })}
        onClearFilters={clearFilters}
      />

      <button
        type="button"
        onClick={() => setDialog({ mode: 'create' })}
        aria-label="Añadir movimiento"
        className="md:hidden fixed right-4 z-20 flex items-center justify-center size-14 rounded-full bg-ink text-white shadow-[var(--shadow-lift)]"
        style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 1rem)' }}
      >
        <Plus size={24} aria-hidden />
      </button>

      {dialog.mode !== 'closed' ? (
        <TransactionDialog
          key={dialog.mode === 'edit' ? dialog.transaction.id : 'create'}
          mode={dialog.mode}
          transaction={dialog.mode === 'edit' ? dialog.transaction : undefined}
          categories={categories}
          onClose={() => setDialog({ mode: 'closed' })}
          onSaved={(message) => { setDialog({ mode: 'closed' }); setFlash(message) }}
        />
      ) : null}
    </div>
  )
}
