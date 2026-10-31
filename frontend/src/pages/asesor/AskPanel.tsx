import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Square } from 'lucide-react'
import { api, keys } from '../../lib/api'
import { formatMonth } from '../../lib/dates'
import { Button, ErrorNote, Field, TextArea } from '../../components/ui'
import { AdvisorText, Sheet, Waiting } from './parts'
import { runStream, useAbortable } from './stream'
import type { Running } from './types'

const MAX_QUESTION = 1000

interface QA {
  id: number
  question: string
  month: string
  phase: 'streaming' | 'done' | 'stopped' | 'error'
  text: string
  error: Error | null
}

/** Preguntas al asesor sobre el mes elegido. Se muestran las de esta visita, la última arriba:
 *  el servidor ya guarda cada conversación como memoria. */
export function AskPanel({ month, running, onRunning, onAnnounce }: {
  month: string
  running: Running
  onRunning: (r: Running) => void
  onAnnounce: (message: string) => void
}) {
  const qc = useQueryClient()
  const headingId = useId()
  const { begin, stop } = useAbortable()
  const nextId = useRef(0)
  const [draft, setDraft] = useState('')
  const [items, setItems] = useState<QA[]>([])
  const busy = running !== null
  const canSend = !busy && draft.trim() !== ''

  /** `retryId`: repite una pregunta que falló, en su sitio y con su mes original. */
  function ask(question: string, qMonth: string, retryId?: number) {
    const id = retryId ?? ++nextId.current
    const patch = (fn: (i: QA) => QA) => setItems((all) => all.map((i) => (i.id === id ? fn(i) : i)))
    const fresh: QA = { id, question, month: qMonth, phase: 'streaming', text: '', error: null }
    setItems((all) => (retryId === undefined ? [fresh, ...all] : all.map((i) => (i.id === id ? fresh : i))))
    onRunning('pregunta')
    onAnnounce('')
    const ctrl = begin()
    void runStream((onEvent, signal) => api.asesor.preguntar(question, qMonth, onEvent, signal), ctrl, {
      onDelta: (t) => patch((i) => ({ ...i, text: i.text + t })),
      onDone: () => {
        patch((i) => ({ ...i, phase: 'done' }))
        void qc.invalidateQueries({ queryKey: keys.asesor })
        onAnnounce('Respuesta lista.')
      },
      // El error se muestra como alerta (ErrorNote); no hace falta anunciarlo dos veces.
      onFail: (error) => patch((i) => ({ ...i, phase: 'error', error })),
      onStop: () => {
        patch((i) => ({ ...i, phase: 'stopped' }))
        onAnnounce('Generación detenida.')
      },
    }).finally(() => onRunning(null))
  }

  function submit() {
    if (!canSend) return
    const question = draft.trim()
    setDraft('')
    ask(question, month)
  }

  // Enter solo salta de línea (se escriben preguntas largas); enviar es Ctrl/Cmd + Enter.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-semibold mb-4">Pregunta al asesor</h2>

      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <Field label="Tu pregunta" hint={`Responde con las cifras de ${formatMonth(month)}. Ctrl o Cmd + Intro para enviar.`}>
          {(props) => (
            <TextArea
              {...props}
              rows={3}
              maxLength={MAX_QUESTION}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Por ejemplo: ¿dónde puedo recortar para llegar al 20 % de ahorro?"
            />
          )}
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className={`text-sm tabular ${draft.length >= MAX_QUESTION ? 'text-over font-medium' : 'text-ink-soft'}`}>
            {draft.length} / {MAX_QUESTION}
          </span>
          <Button type="submit" disabled={!canSend}>Preguntar</Button>
        </div>
        {running === 'analisis' ? (
          <p className="text-sm text-ink-soft">El asesor está escribiendo el análisis. Podrás preguntar cuando termine.</p>
        ) : null}
      </form>

      {items.length > 0 ? (
        <ul aria-label="Preguntas de esta visita" className="mt-8 flex flex-col gap-8">
          {items.map((i) => (
            <li key={i.id} aria-busy={i.phase === 'streaming'}>
              <p className="font-semibold whitespace-pre-wrap break-words max-w-[68ch]">
                <span className="sr-only">Pregunta: </span>{i.question}
              </p>
              <p className="text-sm text-ink-soft mt-0.5 mb-3">Sobre {formatMonth(i.month)}</p>

              {i.phase === 'streaming' || i.text ? (
                <Sheet
                  header={i.phase === 'streaming' ? (
                    <>
                      <p className="text-sm text-ink-soft">{i.text ? 'Escribiendo la respuesta…' : 'Esperando al asesor…'}</p>
                      <Button variant="secondary" size="sm" onClick={stop}>
                        <Square size={12} fill="currentColor" aria-hidden /> Detener
                      </Button>
                    </>
                  ) : i.phase === 'stopped' ? (
                    <p className="text-sm text-ink-soft">Detenido. Esta respuesta no se ha guardado.</p>
                  ) : undefined}
                >
                  <span className="sr-only">Respuesta: </span>
                  {i.text ? <AdvisorText text={i.text} streaming={i.phase === 'streaming'} /> : <Waiting />}
                </Sheet>
              ) : null}

              {i.error ? (
                <div className="mt-3">
                  <ErrorNote error={i.error} onRetry={busy ? undefined : () => ask(i.question, i.month, i.id)} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
