import type { Bucket, Kind, Report, ReportPeriodKind, ReportScope } from '../../lib/types'

export const PERIOD_OPTIONS: { value: ReportPeriodKind; label: string }[] = [
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'year', label: 'Año' },
]

export const SCOPE_OPTIONS: { value: ReportScope; label: string }[] = [
  { value: 'expenses', label: 'Gastos' },
  { value: 'income', label: 'Ingresos' },
  { value: 'all', label: 'Todo' },
]

export const SCOPE_LABEL: Record<ReportScope, string> = {
  expenses: 'Gastos', income: 'Ingresos', all: 'Todo',
}

export const KIND_LABEL: Record<Kind, string> = { income: 'Ingreso', expense: 'Gasto' }

export const BUCKET_LABEL: Record<Bucket, string> = {
  needs: 'Necesidades', wants: 'Deseos', savings: 'Ahorro',
}

/** Tipo de categoría que muestran el gráfico y el PDF según el alcance. */
export function categoryKindFor(scope: ReportScope): Kind {
  return scope === 'income' ? 'income' : 'expense'
}

/** cuentas-<alcance>-<periodo>-<desde>.<ext>, como el nombre del CSV del servidor. */
export function reportFileName(r: Pick<Report, 'scope' | 'period'>, ext: string): string {
  return `cuentas-${r.scope}-${r.period.kind}-${r.period.from}.${ext}`
}

export function pctChange(current: number, previous: number): number | null {
  return previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100
}
