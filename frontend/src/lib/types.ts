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
