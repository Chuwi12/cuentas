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
  /** En el ahorro incluye lo no gastado (igual que el resumen). */
  amount_cents: number
  /** Parte de `amount_cents` que es dinero no gastado; solo > 0 en el ahorro. */
  unspent_cents: number
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

// ── Importación CSV (/api/import/csv) ───────────────────────────────────
export type ImportDateFormat = 'auto' | 'ymd' | 'dmy' | 'mdy'
export type ImportDecimal = 'auto' | 'comma' | 'dot'

export interface ImportMapping {
  /** Índices de columna (base 0). */
  date: number
  amount: number
  description: number | null
  reference: number | null
  has_header: boolean
  date_format: ImportDateFormat
  decimal: ImportDecimal
  /** El banco pone los gastos en positivo. */
  invert_sign: boolean
  /** Zona IANA del navegador ("Europe/Madrid"); solo cuenta para fechas ISO 8601 con zona. */
  tz: string
}

export interface ImportInspect {
  delimiter: string
  /** Primera fila del fichero, sea cabecera o no. */
  headers: string[]
  /** Hasta 5 filas siguientes a la primera. */
  sample: string[][]
}

export interface ImportRow {
  /** Fila de datos, sin contar la cabecera, base 0. */
  index: number
  occurred_on: string | null
  kind: Kind | null
  /** Siempre > 0 cuando existe; el signo lo da `kind`. */
  amount_cents: number | null
  description: string | null
  /** Categoría sugerida. */
  category_id: string | null
  duplicate: boolean
  error: string | null
}

export interface ImportSummary {
  total: number
  valid: number
  duplicates: number
  errors: number
}

export interface ImportPreview {
  /** Formato con el que el servidor ha leído las fechas (también cuando se pidió "auto"). */
  date_format: Exclude<ImportDateFormat, 'auto'>
  rows: ImportRow[]
  summary: ImportSummary
}

export interface ImportResult {
  inserted: number
  duplicates: number
  skipped: number
}

// ── Asesor (docs/ASESOR.md, API pública) ────────────────────────────────
export interface Analisis {
  /** YYYY-MM */
  month: string
  content: string
  /** Modelo que lo generó. */
  model: string
  created_at: string
}

export interface Memoria {
  id: string
  tipo: 'analisis' | 'conversacion'
  /** YYYY-MM; null en conversaciones sin mes. */
  month: string | null
  content: string
  created_at: string
}

/** Línea del stream NDJSON de /asesor/analisis y /asesor/preguntas.
 *  `done` lleva `analisis` solo en /asesor/analisis. */
export type AsesorEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; analisis?: Analisis }
  | { type: 'error'; message: string }
