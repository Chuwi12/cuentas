import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PenLine, RefreshCw, Square } from 'lucide-react'
import { api, ApiError, keys } from '../../lib/api'
import { formatMonth, formatTimestamp } from '../../lib/dates'
import { Button, ErrorNote, Skeleton } from '../../components/ui'
import { AdvisorText, Sheet, Waiting } from './parts'
import { runStream, useAbortable } from './stream'
import type { Running } from './types'

interface Run {
  month: string
  phase: 'streaming' | 'stopped' | 'error'
  text: string
  error: Error | null
}

/** Análisis del mes: el guardado, o el que se está escribiendo ahora. */
export function AnalysisPanel({ month, running, onRunning, onAnnounce }: {
  month: string
  running: Running
  onRunning: (r: Running) => void
  onAnnounce: (message: string) => void
}) {
  const qc = useQueryClient()
  const headingId = useId()
  const { begin, stop } = useAbortable()
  const [run, setRun] = useState<Run | null>(null)

  // retry: false, igual que la sesión: un 404 (aún no hay análisis) no se reintenta.
  const query = useQuery({ queryKey: keys.analisis(month), queryFn: () => api.asesor.analisis(month), retry: false })
  const saved = query.data
  const notFound = query.error instanceof ApiError && query.error.status === 404
  const label = formatMonth(month)
  const current = run?.month === month ? run : null
  const streaming = current?.phase === 'streaming'
  const showRun = current !== null && (streaming || current.text !== '')
  const otherBusy = running === 'pregunta'

  function generate() {
    const ctrl = begin()
    setRun({ month, phase: 'streaming', text: '', error: null })
    onRunning('analisis')
    onAnnounce('')
    void runStream((onEvent, signal) => api.asesor.generar(month, onEvent, signal), ctrl, {
      onDelta: (t) => setRun((r) => r && { ...r, text: r.text + t }),
      onDone: (e) => {
        if (e.analisis) qc.setQueryData(keys.analisis(month), e.analisis)
        setRun(null)
        void qc.invalidateQueries({ queryKey: keys.asesor })
        onAnnounce(`Análisis de ${label} terminado.`)
      },
      // El error se muestra como alerta (ErrorNote); no hace falta anunciarlo dos veces.
      onFail: (error) => setRun((r) => r && { ...r, phase: 'error', error }),
      onStop: () => {
        setRun((r) => (r && r.text ? { ...r, phase: 'stopped' } : null))
        onAnnounce('Generación detenida.')
      },
    }).finally(() => onRunning(null))
  }

  // La acción principal del estado vacío es grande; "Regenerar" y "Generar de nuevo" son secundarias.
  const generateButton = (text: string, primary = false) => (
    <Button variant={primary ? 'primary' : 'secondary'} size={primary ? 'md' : 'sm'} disabled={running !== null} onClick={generate}>
      {primary ? <PenLine size={16} aria-hidden /> : <RefreshCw size={14} aria-hidden />}
      {text}
    </Button>
  )
  const busyHint = otherBusy
    ? <p className="text-sm text-ink-soft">El asesor está respondiendo una pregunta. Podrás generar el análisis cuando termine.</p>
    : null

  return (
    <section aria-labelledby={headingId} aria-busy={streaming}>
      <h2 id={headingId} className="text-lg font-semibold mb-4">Análisis del mes</h2>

      {/* Con texto a medias el aviso va debajo, para no empujar lo que se está leyendo. */}
      {current?.error && !showRun ? <div className="mb-4"><ErrorNote error={current.error} /></div> : null}

      {showRun ? (
        <Sheet
          header={streaming ? (
            <>
              <p className="text-sm text-ink-soft">Escribiendo el análisis de {label}…</p>
              <Button variant="secondary" size="sm" onClick={stop}>
                <Square size={12} fill="currentColor" aria-hidden /> Detener
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-soft">
                {current.phase === 'stopped' ? 'Detenido.' : 'Interrumpido.'} Este análisis no se ha guardado.
              </p>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setRun(null)}>Descartar</Button>
                {generateButton('Generar de nuevo')}
              </div>
            </>
          )}
        >
          {streaming ? (
            <p className="text-sm text-ink-soft max-w-[68ch] mb-4">
              En un servidor modesto puede tardar unos minutos. Mantén esta página abierta: si sales, se corta y no se guarda.
            </p>
          ) : null}
          {current.text ? <AdvisorText text={current.text} streaming={streaming} /> : <Waiting />}
        </Sheet>
      ) : saved ? (
        <Sheet
          header={(
            <>
              <p className="text-sm text-ink-soft">Generado el {formatTimestamp(saved.created_at)} con {saved.model}</p>
              {generateButton('Regenerar')}
            </>
          )}
        >
          <AdvisorText text={saved.content} />
        </Sheet>
      ) : query.isLoading ? (
        <Skeleton className="h-56 w-full rounded-[var(--radius-panel)]" />
      ) : notFound ? (
        // La hoja en blanco donde se va a escribir el análisis.
        <Sheet>
          <div className="flex flex-col items-start gap-3 max-w-[56ch]">
            <p className="text-lg font-semibold">Aún no hay análisis de {label}</p>
            <p className="text-ink-soft">
              El asesor lee las cifras del mes y te explica cómo va tu reparto 50/30/20. Funciona en tu propio servidor:
              tus datos no salen de él, y puede tardar unos minutos.
            </p>
            {generateButton('Generar análisis', true)}
            {busyHint}
          </div>
        </Sheet>
      ) : query.isError ? (
        <ErrorNote error={query.error} onRetry={() => query.refetch()} />
      ) : null}

      {current?.error && showRun ? <div className="mt-4"><ErrorNote error={current.error} /></div> : null}
      {saved && !showRun && busyHint ? <div className="mt-3">{busyHint}</div> : null}
    </section>
  )
}
