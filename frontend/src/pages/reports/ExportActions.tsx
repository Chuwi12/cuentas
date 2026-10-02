import { useState } from 'react'
import { FileDown, Table2 } from 'lucide-react'
import { AnchorButton, Button, cx } from '../../components/ui'
import { reportCsvUrl, type ReportParams } from '../../lib/api'
import type { Report } from '../../lib/types'

/** PDF (se genera en el navegador con el mismo JSON) y CSV (lo sirve el backend). */
export function ExportActions({ params, report }: { params: ReportParams; report: Report | undefined }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disabled = !report || report.totals.transaction_count === 0

  const downloadPdf = async () => {
    if (!report) return
    setBusy(true)
    setError(null)
    try {
      // jsPDF y autotable solo se descargan aquí, no en el bundle inicial.
      const { downloadReportPdf } = await import('./pdf')
      downloadReportPdf(report)
    } catch {
      setError('No se ha podido generar el PDF. Inténtalo de nuevo.')
    } finally {
      setBusy(false)
    }
  }

  const csv = (detail: 'transactions' | 'categories', label: string) => (
    <AnchorButton
      variant="secondary"
      href={disabled ? undefined : reportCsvUrl(params, detail)}
      download
      aria-disabled={disabled || undefined}
      className={cx(disabled && 'opacity-40 pointer-events-none')}
    >
      <Table2 size={18} aria-hidden /> {label}
    </AnchorButton>
  )

  return (
    <div className="flex flex-col items-start md:items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={downloadPdf} loading={busy} disabled={disabled}>
          {busy ? 'Generando…' : <><FileDown size={18} aria-hidden /> Descargar PDF</>}
        </Button>
        {csv('transactions', 'Movimientos (CSV)')}
        {csv('categories', 'Por categoría (CSV)')}
      </div>
      {error ? <p role="alert" className="text-sm text-over">{error}</p> : null}
    </div>
  )
}
