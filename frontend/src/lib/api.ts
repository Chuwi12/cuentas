import type {
  Analisis, AsesorEvent, Category, CategoryInput, Memoria, MonthSummary, Page, Report, ReportPeriodKind,
  ReportScope, Transaction, TransactionInput, TrendPoint, User,
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

async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e // abortar a propósito no es un fallo de red
    throw new ApiError(0, 'network', 'No hay conexión con el servidor. Comprueba que el backend está arrancado.')
  }
}

/** Respuesta con status ≠ 2xx y cuerpo `{error:{code,message}}` → ApiError. */
async function toApiError(res: Response): Promise<ApiError> {
  const data = await res.json().catch(() => null)
  return new ApiError(res.status, data?.error?.code ?? 'internal', data?.error?.message ?? `Error ${res.status}`)
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body)
  if (res.status === 204) return undefined as T
  if (!res.ok) throw await toApiError(res)
  return (await res.json().catch(() => null)) as T
}

/** POST cuya respuesta es NDJSON (una línea JSON por evento). Llama a `onEvent` según llegan y
 *  resuelve cuando el servidor cierra el stream; que el stream acabe sin evento final lo decide
 *  quien llama. Un status ≠ 200 antes del stream es un ApiError, como en `request`. Abortar con
 *  `signal` rechaza con el AbortError del navegador. */
export async function streamNdjson<E>(
  path: string, body: unknown, onEvent: (event: E) => void, signal?: AbortSignal,
): Promise<void> {
  const res = await send('POST', path, body, signal)
  if (!res.ok) throw await toApiError(res)
  if (!res.body) throw new ApiError(0, 'stream', 'Este navegador no admite respuestas en streaming.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const read = async () => {
    try {
      return await reader.read()
    } catch (e) {
      if (signal?.aborted) throw e
      throw new ApiError(0, 'network', 'La conexión con el asesor se cortó antes de terminar.')
    }
  }
  const emit = (line: string) => {
    if (!line.trim()) return
    let event: E
    try {
      event = JSON.parse(line) as E
    } catch {
      void reader.cancel() // si no, el servidor seguiría generando para nadie y el reintento daría 409
      throw new ApiError(0, 'stream', 'El asesor ha enviado una respuesta que no se puede leer.')
    }
    onEvent(event)
  }

  let buffer = ''
  for (;;) {
    const { done, value } = await read()
    buffer += decoder.decode(value, { stream: !done })
    // Una línea puede llegar partida entre trozos: solo se emite lo que ya tiene su salto.
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      emit(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
    if (done) break
  }
  emit(buffer) // última línea sin salto final
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

export interface ReportParams {
  period: ReportPeriodKind
  /** Cualquier día dentro del periodo (YYYY-MM-DD). */
  date: string
  scope: ReportScope
}

export type ReportCsvDetail = 'transactions' | 'categories'

/** URL de descarga del CSV. Mismo origen: la cookie de sesión viaja sola. */
export function reportCsvUrl(p: ReportParams, detail: ReportCsvDetail): string {
  return `/api/reports/export.csv${qs({ ...p, detail })}`
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
  reports: {
    get: (p: ReportParams) => request<Report>('GET', `/reports${qs({ ...p })}`),
  },
  asesor: {
    /** 404 `not_found` si el mes aún no tiene análisis. */
    analisis: (month: string) => request<Analisis>('GET', `/asesor/analisis${qs({ month })}`),
    generar: (month: string, onEvent: (e: AsesorEvent) => void, signal: AbortSignal) =>
      streamNdjson<AsesorEvent>('/asesor/analisis', { month }, onEvent, signal),
    preguntar: (question: string, month: string, onEvent: (e: AsesorEvent) => void, signal: AbortSignal) =>
      streamNdjson<AsesorEvent>('/asesor/preguntas', { question, month }, onEvent, signal),
    memorias: () => request<Memoria[]>('GET', '/asesor/memorias'),
    borrarMemoria: (id: string) => request<void>('DELETE', `/asesor/memorias/${id}`),
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
  report: (p: ReportParams) => ['finanzas', 'report', p.period, p.date, p.scope] as const,
  /** Prefijo de todo lo del asesor: invalidarlo refresca análisis y memoria. */
  asesor: ['finanzas', 'asesor'] as const,
  analisis: (month: string) => ['finanzas', 'asesor', 'analisis', month] as const,
  memorias: ['finanzas', 'asesor', 'memorias'] as const,
}
