import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, keys, type ReportParams } from '../lib/api'
import { formatPeriodLabel, periodRange, todayISO } from '../lib/dates'
import { EmptyState, ErrorNote, PageHeader, Skeleton } from '../components/ui'
import type { ReportPeriodKind, ReportScope } from '../lib/types'
import { PeriodControls } from './reports/PeriodControls'
import { ExportActions } from './reports/ExportActions'
import { KpiCards } from './reports/KpiCards'
import { SeriesChart } from './reports/SeriesChart'
import { CategoryChart, CategoryTable } from './reports/CategorySection'
import { BucketTargets } from './reports/BucketTargets'
import { TopTransactions } from './reports/TopTransactions'
import { Insights } from './reports/Insights'

const KINDS: ReportPeriodKind[] = ['week', 'month', 'year']
const SCOPES: ReportScope[] = ['expenses', 'income', 'all']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Lee el estado de la URL y lo sanea: así recargar o compartir el enlace conserva la vista. */
function readParams(sp: URLSearchParams): ReportParams {
  const today = todayISO()
  const k = sp.get('periodo') as ReportPeriodKind | null
  const s = sp.get('alcance') as ReportScope | null
  const d = sp.get('fecha')
  return {
    period: k && KINDS.includes(k) ? k : 'month',
    scope: s && SCOPES.includes(s) ? s : 'all',
    date: d && DATE_RE.test(d) && d >= '2000-01-01' && d <= today ? d : today,
  }
}

export default function ReportsPage() {
  const [sp, setSp] = useSearchParams()
  const params = readParams(sp)

  const update = (patch: Partial<ReportParams>) => {
    const next = { ...params, ...patch }
    setSp({ periodo: next.period, fecha: next.date, alcance: next.scope })
  }

  const { from, to } = periodRange(params.period, params.date)
  // La petición usa el primer día del periodo: cualquier día de la misma semana, mes o año
  // comparte así una sola entrada de caché.
  const request: ReportParams = { ...params, date: from }
  const query = useQuery({
    queryKey: keys.report(request),
    queryFn: () => api.reports.get(request),
    placeholderData: keepPreviousData,
  })
  const report = query.data
  const label = formatPeriodLabel(params.period, from, to)

  return (
    <div>
      <PageHeader title="Informes">
        <ExportActions params={request} report={query.isPlaceholderData ? undefined : report} />
      </PageHeader>

      <PeriodControls
        kind={params.period}
        date={params.date}
        scope={params.scope}
        onKind={(period) => update({ period })}
        onDate={(date) => update({ date: date > todayISO() ? todayISO() : date })}
        onScope={(scope) => update({ scope })}
      />

      <div aria-busy={query.isFetching} className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
        {query.isLoading ? (
          <ReportSkeleton />
        ) : query.isError && !report ? (
          <ErrorNote error={query.error} onRetry={() => query.refetch()} />
        ) : !report ? null : report.totals.transaction_count === 0 ? (
          <EmptyState title={`Sin movimientos en ${label}`}>
            Elige otro periodo o registra movimientos para ver aquí el informe.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-10">
            {query.isError ? <ErrorNote error={query.error} onRetry={() => query.refetch()} /> : null}
            <KpiCards totals={report.totals} previous={report.previous.totals} />
            <SeriesChart series={report.series} kind={report.period.kind} scope={report.scope} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
              <CategoryChart rows={report.by_category} scope={report.scope} />
              {report.scope !== 'income' ? <BucketTargets rows={report.buckets} /> : null}
            </div>
            <CategoryTable rows={report.by_category} />
            <TopTransactions items={report.top_transactions} />
            <Insights items={report.insights} />
          </div>
        )}
      </div>
    </div>
  )
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-label="Cargando informe">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
      </div>
      <Skeleton className="h-72 w-full rounded-[var(--radius-panel)]" />
      <Skeleton className="h-48 w-full" />
    </div>
  )
}
