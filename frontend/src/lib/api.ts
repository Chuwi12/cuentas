import type {
  Category, CategoryInput, MonthSummary, Page, Transaction, TransactionInput, TrendPoint, User,
} from './types'

/** Error del backend con el `code` del contrato (`validation`, `conflict`…). */
export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', 'No hay conexión con el servidor. Comprueba que el backend está arrancado.')
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'internal',
      data?.error?.message ?? `Error ${res.status}`,
    )
  }
  return data as T
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  }
  const out = s.toString()
  return out ? `?${out}` : ''
}

export interface TransactionFilters {
  from?: string
  to?: string
  kind?: 'income' | 'expense'
  category_id?: string
  bucket?: 'needs' | 'wants' | 'savings'
  q?: string
  page?: number
  per_page?: number
}

export const api = {
  auth: {
    status: () => request<{ registration_open: boolean }>('GET', '/auth/status'),
    me: () => request<{ user: User }>('GET', '/auth/me'),
    login: (email: string, password: string) =>
      request<{ user: User }>('POST', '/auth/login', { email, password }),
    register: (email: string, password: string) =>
      request<{ user: User }>('POST', '/auth/register', { email, password }),
    logout: () => request<void>('POST', '/auth/logout'),
  },
  categories: {
    list: (includeArchived = false) =>
      request<Category[]>('GET', `/categories${qs({ include_archived: includeArchived })}`),
    create: (input: CategoryInput) => request<Category>('POST', '/categories', input),
    update: (id: string, patch: Partial<CategoryInput & { is_archived: boolean; sort_order: number }>) =>
      request<Category>('PATCH', `/categories/${id}`, patch),
    remove: (id: string) => request<void>('DELETE', `/categories/${id}`),
  },
  transactions: {
    list: (f: TransactionFilters = {}) =>
      request<Page<Transaction>>('GET', `/transactions${qs({ ...f })}`),
    create: (input: TransactionInput) => request<Transaction>('POST', '/transactions', input),
    update: (id: string, patch: Partial<TransactionInput>) =>
      request<Transaction>('PATCH', `/transactions/${id}`, patch),
    remove: (id: string) => request<void>('DELETE', `/transactions/${id}`),
  },
  summary: {
    month: (month?: string) => request<MonthSummary>('GET', `/summary${qs({ month })}`),
    trend: (months = 12) => request<{ points: TrendPoint[] }>('GET', `/summary/trend${qs({ months })}`),
  },
}

/** Claves de react-query. Tras crear/editar/borrar movimientos o categorías,
 *  invalida `keys.all` para que Resumen y Movimientos se recalculen. */
export const keys = {
  all: ['finanzas'] as const,
  me: ['finanzas', 'me'] as const,
  categories: (archived = false) => ['finanzas', 'categories', archived] as const,
  transactions: (f: TransactionFilters) => ['finanzas', 'transactions', f] as const,
  summary: (month: string) => ['finanzas', 'summary', month] as const,
  trend: (months: number) => ['finanzas', 'trend', months] as const,
}
