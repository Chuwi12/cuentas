import { useInfiniteQuery } from '@tanstack/react-query'
import { Circle } from 'lucide-react'
import { api, keys, type TransactionFilters as ApiTransactionFilters } from '../../lib/api'
import { formatCents } from '../../lib/money'
import { formatDay, formatMonth } from '../../lib/dates'
import { CategoryIcon } from '../../lib/icons'
import { Button, BucketTag, EmptyState, ErrorNote, Money, Skeleton, cx } from '../../components/ui'
import type { Transaction } from '../../lib/types'

const PAGE_SIZE = 200

interface DayGroup {
  day: string
  items: Transaction[]
}

export function TransactionList({ month, filters, hasActiveFilters, onEdit, onAdd, onClearFilters }: {
  month: string
  filters: ApiTransactionFilters
  hasActiveFilters: boolean
  onEdit: (tx: Transaction) => void
  onAdd: () => void
  onClearFilters: () => void
}) {
  const query = useInfiniteQuery({
    queryKey: keys.transactions(filters),
    queryFn: ({ pageParam }) => api.transactions.list({ ...filters, page: pageParam, per_page: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.per_page < last.total ? last.page + 1 : undefined),
  })

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
      </div>
    )
  }

  if (query.isError) {
    return <ErrorNote error={query.error} onRetry={() => query.refetch()} />
  }

  const items = query.data?.pages.flatMap((p) => p.items) ?? []
  const total = query.data?.pages[0]?.total ?? 0
  const loadedAll = items.length >= total

  if (items.length === 0) {
    return hasActiveFilters ? (
      <EmptyState title="Ningún movimiento con estos filtros">
        <p>Prueba a quitar algún filtro para ver más resultados.</p>
        <Button variant="secondary" onClick={onClearFilters} className="mt-1">Quitar filtros</Button>
      </EmptyState>
    ) : (
      <EmptyState title={`Aún no hay movimientos en ${formatMonth(month)}`}>
        <p>Apunta tu primer gasto o ingreso del mes.</p>
        <Button onClick={onAdd} className="mt-1">Añadir movimiento</Button>
      </EmptyState>
    )
  }

  const incomeCents = items.filter((i) => i.kind === 'income').reduce((s, i) => s + i.amount_cents, 0)
  const expenseCents = items.filter((i) => i.kind === 'expense').reduce((s, i) => s + i.amount_cents, 0)

  const groups: DayGroup[] = []
  for (const tx of items) {
    const last = groups[groups.length - 1]
    if (last && last.day === tx.occurred_on) last.items.push(tx)
    else groups.push({ day: tx.occurred_on, items: [tx] })
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-5 text-sm">
        <span className="text-ink-soft">
          Ingresos <Money cents={incomeCents} kind="income" className="font-semibold" />
        </span>
        <span className="text-ink-soft">
          Gastos <Money cents={expenseCents} kind="expense" className="font-semibold" />
        </span>
        {!loadedAll ? <span className="text-ink-faint">(de lo cargado, quedan movimientos por cargar)</span> : null}
      </div>

      <div>
        {groups.map((group) => (
          <DayGroupRows key={group.day} group={group} onEdit={onEdit} />
        ))}
      </div>

      {query.hasNextPage ? (
        <div className="pt-4">
          <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
            Cargar más
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function DayGroupRows({ group, onEdit }: { group: DayGroup; onEdit: (tx: Transaction) => void }) {
  const net = group.items.reduce((s, i) => s + (i.kind === 'income' ? i.amount_cents : -i.amount_cents), 0)
  return (
    <div>
      <div className="flex items-baseline justify-between pt-5 pb-1 first:pt-0">
        <h3 className="text-sm font-semibold text-ink-soft">{formatDay(group.day)}</h3>
        <span className={cx('text-sm tabular', net >= 0 ? 'text-income' : 'text-ink-soft')}>
          {net >= 0 ? '+' : '−'}{formatCents(Math.abs(net))}
        </span>
      </div>
      <ul>
        {group.items.map((tx) => (
          <li key={tx.id} className="border-b border-rule last:border-0">
            <button
              type="button"
              onClick={() => onEdit(tx)}
              className="w-full flex items-center gap-3 py-3 px-1 -mx-1 text-left rounded-[var(--radius-control)] hover:bg-rule/60"
            >
              <span
                className="flex items-center justify-center size-9 rounded-full shrink-0"
                style={{ backgroundColor: tx.category ? `${tx.category.color}1f` : 'var(--color-rule)' }}
                aria-hidden
              >
                <span style={{ color: tx.category ? tx.category.color : 'var(--color-ink-faint)' }}>
                  {tx.category ? <CategoryIcon name={tx.category.icon} size={17} /> : <Circle size={17} />}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate text-[15px]', tx.category ? 'text-ink' : 'text-ink-soft italic')}>
                  {tx.category ? tx.category.name : 'Sin categoría'}
                </span>
                {tx.description ? <span className="block truncate text-sm text-ink-soft">{tx.description}</span> : null}
              </span>
              {tx.kind === 'expense' && tx.category?.bucket ? <BucketTag bucket={tx.category.bucket} /> : null}
              <Money cents={tx.amount_cents} kind={tx.kind} className="text-[15px] font-medium shrink-0" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
