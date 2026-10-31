import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { api, keys } from '../../lib/api'
import { formatMonthTitle, formatTimestamp } from '../../lib/dates'
import { Button, EmptyState, ErrorNote, Skeleton, cx } from '../../components/ui'
import type { Memoria } from '../../lib/types'

const TIPO: Record<Memoria['tipo'], { label: string; tag: string }> = {
  analisis: { label: 'Análisis', tag: 'bg-needs-soft text-needs-ink' },
  conversacion: { label: 'Conversación', tag: 'bg-rule text-ink-soft' },
}

/** Lo que el asesor recuerda. Plegado por defecto: no se pide hasta que se abre. */
export function MemoryPanel({ onAnnounce }: { onAnnounce: (message: string) => void }) {
  const qc = useQueryClient()
  const headingId = useId()
  const bodyId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const query = useQuery({ queryKey: keys.memorias, queryFn: api.asesor.memorias, enabled: open })
  const remove = useMutation({
    mutationFn: (id: string) => api.asesor.borrarMemoria(id),
    onSuccess: async () => {
      await Promise.all([
        // reset y no invalidate: un refetch con 404 conserva los datos viejos y el panel seguiría mostrando el análisis borrado.
        qc.resetQueries({ queryKey: [...keys.asesor, 'analisis'] }),
        qc.invalidateQueries({ queryKey: keys.memorias }),
      ])
      setConfirmId(null)
      onAnnounce('Recuerdo borrado.')
      // La fila borrada se lleva el foco: se devuelve a la cabecera de la sección.
      toggleRef.current?.focus()
    },
  })
  const items = query.data

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-semibold">
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 -ml-1 pl-1 pr-2 min-h-11 rounded-[var(--radius-control)] hover:bg-rule transition-colors"
        >
          <ChevronRight size={18} aria-hidden className={cx('transition-transform', open && 'rotate-90')} />
          Memoria del asesor
          {items ? <span className="text-ink-soft font-normal tabular">({items.length})</span> : null}
        </button>
      </h2>
      <p className="text-ink-soft max-w-[68ch]">
        Lo que el asesor guarda de cada análisis y conversación para recordar sus consejos anteriores y comprobar si te funcionaron.
      </p>

      <div id={bodyId} hidden={!open} className="mt-4">
        {!open ? null : query.isLoading ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
          </div>
        ) : query.isError ? (
          <ErrorNote error={query.error} onRetry={() => query.refetch()} />
        ) : items && items.length === 0 ? (
          <EmptyState title="El asesor aún no recuerda nada">
            Después del primer análisis o de la primera pregunta, aparecerá aquí.
          </EmptyState>
        ) : (
          <>
            {remove.isError ? <div className="mb-3"><ErrorNote error={remove.error} /></div> : null}
            <ul className="border-t border-rule">
              {items?.map((m) => (
                <MemoryRow
                  key={m.id}
                  memoria={m}
                  confirming={confirmId === m.id}
                  deleting={remove.isPending && confirmId === m.id}
                  onAskDelete={() => { remove.reset(); setConfirmId(m.id) }}
                  onCancel={() => setConfirmId(null)}
                  onDelete={() => remove.mutate(m.id)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

function MemoryRow({ memoria: m, confirming, deleting, onAskDelete, onCancel, onDelete }: {
  memoria: Memoria; confirming: boolean; deleting: boolean
  onAskDelete: () => void; onCancel: () => void; onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const bodyId = useId()
  const bodyRef = useRef<HTMLParagraphElement>(null)
  const tipo = TIPO[m.tipo]

  // "Ver entero" solo si el recorte a tres líneas esconde algo: se mide, porque depende del ancho.
  useEffect(() => {
    const el = bodyRef.current
    if (!el || expanded) return
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [expanded, m.content])

  return (
    <li className="py-4 border-b border-rule">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className={cx('inline-flex items-center h-6 px-2 rounded text-xs font-medium', tipo.tag)}>{tipo.label}</span>
        <span className="font-medium">{m.month ? formatMonthTitle(m.month) : 'Sin mes'}</span>
        <span className="text-ink-soft">{formatTimestamp(m.created_at)}</span>
      </div>
      {/* Recortado, el texto fluye en un párrafo (los saltos de línea gastarían las tres líneas). */}
      <p
        id={bodyId}
        ref={bodyRef}
        className={cx('mt-2 text-[15px] leading-relaxed break-words max-w-[68ch]', expanded ? 'whitespace-pre-wrap' : 'line-clamp-3')}
      >
        {expanded ? m.content : m.content.replace(/\s*\n\s*/g, ' ')}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {expanded || clamped ? (
          <Button variant="ghost" size="sm" className="-ml-3" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((x) => !x)}>
            {expanded ? 'Ver menos' : 'Ver entero'}
          </Button>
        ) : <span />}
        {confirming ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" autoFocus onClick={onCancel}>Cancelar</Button>
            <Button variant="danger" size="sm" loading={deleting} onClick={onDelete}>Sí, borrar recuerdo</Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" className="-mr-3" onClick={onAskDelete}>Borrar</Button>
        )}
      </div>
    </li>
  )
}
