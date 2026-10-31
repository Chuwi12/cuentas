import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { currentMonth, MIN_DATE } from '../lib/dates'
import { PageHeader } from '../components/ui'
import { MonthNav } from './dashboard/MonthNav'
import { AnalysisPanel } from './asesor/AnalysisPanel'
import { AskPanel } from './asesor/AskPanel'
import { MemoryPanel } from './asesor/MemoryPanel'
import type { Running } from './asesor/types'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** El mes de la URL, o el actual si falta, es inválido, está en el futuro o es anterior al rango del backend (2000-01). */
function canonicalMonth(raw: string | null): string {
  const max = currentMonth()
  return raw && MONTH_RE.test(raw) && raw >= MIN_DATE.slice(0, 7) && raw <= max ? raw : max
}

export default function AsesorPage() {
  const [sp, setSp] = useSearchParams()
  const month = canonicalMonth(sp.get('mes'))
  const [running, setRunning] = useState<Running>(null)
  // Una región aria-live breve para cuando algo termina: los tokens no pasan por ella.
  const [announcement, setAnnouncement] = useState('')

  return (
    <div className="max-w-3xl">
      <PageHeader title="Asesor" />

      {/* Mientras se escribe el análisis de un mes no se cambia de mes: fieldset desactiva el selector. */}
      <fieldset disabled={running === 'analisis'} className="mb-8 min-w-0">
        <MonthNav month={month} onChange={(m) => setSp({ mes: m })} />
      </fieldset>

      <div className="flex flex-col gap-12">
        <AnalysisPanel month={month} running={running} onRunning={setRunning} onAnnounce={setAnnouncement} />
        <AskPanel month={month} running={running} onRunning={setRunning} onAnnounce={setAnnouncement} />
        <MemoryPanel onAnnounce={setAnnouncement} />
      </div>

      <p role="status" className="sr-only">{announcement}</p>
    </div>
  )
}
