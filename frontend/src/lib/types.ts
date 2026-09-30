// Espejo de docs/API.md. Si cambias el contrato, cambia esto a la vez.

export type Kind = 'income' | 'expense'
export type Bucket = 'needs' | 'wants' | 'savings'

export interface User {
  id: string
  email: string
  created_at: string
}

export interface Category {
  id: string
  name: string
  kind: Kind
  bucket: Bucket | null
  color: string
  icon: string
  is_archived: boolean
  sort_order: number
}

export interface Transaction {
  id: string
  kind: Kind
  /** Siempre positivo; el signo lo da `kind`. */
  amount_cents: number
  category_id: string | null
  category: Category | null
  /** YYYY-MM-DD */
  occurred_on: string
  description: string | null
  created_at: string
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  per_page: number
}

export interface BucketSummary {
  bucket: Bucket
  target_pct: number
  target_cents: number
  actual_cents: number
  delta_cents: number
  actual_pct: number
}

export interface MonthSummary {
  month: string
  income_cents: number
  expense_cents: number
  buckets: BucketSummary[]
  uncategorized_expense_cents: number
  by_category: { category: Category; amount_cents: number; pct_of_income: number }[]
}

export interface TrendPoint {
  month: string
  income_cents: number
  needs_cents: number
  wants_cents: number
  savings_cents: number
}

export interface TransactionInput {
  kind: Kind
  amount_cents: number
  category_id: string | null
  occurred_on: string
  description: string | null
}

export interface CategoryInput {
  name: string
  kind: Kind
  bucket: Bucket | null
  color: string
  icon: string
}

// ── Informes (GET /api/reports) ─────────────────────────────────────────
export type ReportPeriodKind = 'week' | 'month' | 'year'
export type ReportScope = 'expenses' | 'income' | 'all'
export type InsightLevel = 'good' | 'info' | 'warning'

export interface ReportPeriod {
  kind: ReportPeriodKind
  /** YYYY-MM-DD */
  from: string
  /** YYYY-MM-DD, inclusivo */
  to: string
}

export interface ReportTotals {
  income_cents: number
  expense_cents: number
  net_cents: number
  transaction_count: number
  /** Puntos básicos (10000 = 100 %). null si no hubo ingresos. */
  savings_rate_bp: number | null
}

export interface ReportSeriesPoint {
  from: string
  to: string
  income_cents: number
  expense_cents: number
}

export interface ReportCategoryRow {
  category_id: string | null
  name: string
  color: string
  kind: Kind
  bucket: Bucket | null
  amount_cents: number
  count: number
  share_bp: number
}

export interface ReportBucketRow {
  bucket: Bucket | null
  amount_cents: number
  target_cents: number | null
  income_share_bp: number | null
}

export interface ReportTopTransaction {
  id: string
  occurred_on: string
  kind: Kind
  amount_cents: number
  description: string | null
  category_name: string | null
  category_color: string | null
}

export interface ReportInsight {
  code: string
  level: InsightLevel
  message: string
}

export interface Report {
  period: ReportPeriod
  scope: ReportScope
  totals: ReportTotals
  previous: { period: ReportPeriod; totals: ReportTotals }
  series: ReportSeriesPoint[]
  by_category: ReportCategoryRow[]
  buckets: ReportBucketRow[]
  top_transactions: ReportTopTransaction[]
  insights: ReportInsight[]
}
