import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { api, keys } from '../lib/api'
import { currentMonth, formatMonth } from '../lib/dates'
import { EmptyState, ErrorNote, LinkButton, PageHeader, Skeleton } from '../components/ui'
import { MonthNav } from './dashboard/MonthNav'
import { AllocationBar } from './dashboard/AllocationBar'
import { BucketColumns } from './dashboard/BucketColumns'
import { TrendChart } from './dashboard/TrendChart'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** El mes de la URL, o el mes actual si falta, es inválido o está en el futuro. */
function canonicalMonth(raw: string | null): string {
  const max = currentMonth()
  if (raw && MONTH_RE.test(raw) && raw <= max) return raw
  return max
}

export default function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const month = canonicalMonth(searchParams.get('mes'))

  // Mantiene ?mes=YYYY-MM en la URL aunque falte o sea inválido, para que
  // recargar o compartir el enlace conserve exactamente esta vista.
  useEffect(() => {
    if (searchParams.get('mes') !== month) {
      const next = new URLSearchParams(searchParams)
      next.set('mes', month)
      setSearchParams(next, { replace: true })
    }
  }, [month, searchParams, setSearchParams])

  const goToMonth = (m: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('mes', m)
    setSearchParams(next)
  }

  const summaryQuery = useQuery({ queryKey: keys.summary(month), queryFn: () => api.summary.month(month) })
  const trendQuery = useQuery({ queryKey: keys.trend(12), queryFn: () => api.summary.trend(12) })

  const summary = summaryQuery.data
  const isEmptyMonth = summary ? summary.income_cents === 0 && summary.expense_cents === 0 : false

  return (
    <div>
      <PageHeader title="Resumen">
        <AddTransactionLink />
      </PageHeader>

      <div className="mb-6">
        <MonthNav month={month} onChange={goToMonth} />
      </div>

      <div className="flex flex-col gap-10">
        <section>
          {summaryQuery.isLoading ? (
            <SummarySkeleton />
          ) : summaryQuery.isError ? (
            <ErrorNote error={summaryQuery.error} onRetry={() => summaryQuery.refetch()} />
          ) : !summary ? null : isEmptyMonth ? (
            <EmptyState title={`Sin movimientos en ${formatMonth(month)}`} action={<AddTransactionLink />}>
              Registra un ingreso o un gasto para ver aquí el reparto 50/30/20 del mes.
            </EmptyState>
          ) : (
            <>
              <AllocationBar summary={summary} />
              <div className="mt-10">
                <BucketColumns summary={summary} hasIncome={summary.income_cents > 0} />
              </div>
            </>
          )}
        </section>

        <section>
          {trendQuery.isLoading ? (
            <Skeleton className="h-72 w-full rounded-[var(--radius-panel)]" />
          ) : trendQuery.isError ? (
            <ErrorNote error={trendQuery.error} onRetry={() => trendQuery.refetch()} />
          ) : trendQuery.data ? (
            <TrendChart points={trendQuery.data.points} />
          ) : null}
        </section>
      </div>
    </div>
  )
}

/** Acción principal: siempre el mismo verbo, botón u opción del estado vacío. */
function AddTransactionLink() {
  return (
    <LinkButton to="/movimientos?nuevo=1">
      <Plus size={18} aria-hidden /> Añadir movimiento
    </LinkButton>
  )
}

function SummarySkeleton() {
  return (
    <div>
      <div className="graph-paper rounded-[var(--radius-panel)] border border-grid p-5 md:p-8">
        <div className="flex gap-8">
          <Skeleton className="h-12 w-40" />
          <Skeleton className="h-12 w-32" />
        </div>
        <Skeleton className="h-14 md:h-16 w-full rounded-[4px] mt-10" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-10">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    </div>
  )
}
