import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { api, ApiError, keys } from '../lib/api'
import { LinkButton, PageHeader } from '../components/ui'
import type { ImportInspect, ImportMapping, ImportPreview, ImportResult } from '../lib/types'
import { FileStep } from './import/FileStep'
import { MappingStep } from './import/MappingStep'
import { PreviewStep } from './import/PreviewStep'
import { ResultStep } from './import/ResultStep'
import { Stepper } from './import/Steps'
import { DATE_FORMAT_NAME, guessForm, loadMapping, saveMapping, toMapping, type MappingForm } from './import/mapping'
import { readCsvFile } from './import/readCsv'
import { isSelectable, noPicks, type Picks } from './import/selection'

type StepIndex = 0 | 1 | 2 | 3

interface Loaded {
  name: string
  size: number
  text: string
  inspect: ImportInspect
  /** El formulario se rellenó con el último mapeo guardado para estas cabeceras. */
  remembered: boolean
}

const nf = new Intl.NumberFormat('es-ES')
const count = (n: number, one: string, many: string) => `${nf.format(n)} ${n === 1 ? one : many}`

/** El servidor no sabe qué formato de fecha es: hay que elegirlo a mano. */
const isAmbiguousDate = (e: unknown): e is ApiError =>
  e instanceof ApiError && e.code === 'ambiguous_date'

/**
 * Importar movimientos desde un CSV, en cuatro pasos. Todo lo elegido vive aquí, no en los pasos,
 * para que volver atrás no pierda el fichero, el mapeo ni las marcas de la previsualización.
 */
export default function ImportPage() {
  const qc = useQueryClient()
  const [step, setStep] = useState<StepIndex>(0)
  // El primer paso no roba el foco al abrir la página; los cambios de paso sí.
  const [navigated, setNavigated] = useState(false)
  // Al volver desde la previsualización para cambiar el formato de fecha, el foco va a ese campo.
  const [focusDateFormat, setFocusDateFormat] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [form, setForm] = useState<MappingForm | null>(null)
  const [preview, setPreview] = useState<{ key: string; data: ImportPreview } | null>(null)
  const [picks, setPicks] = useState<Picks>(noPicks)
  const [result, setResult] = useState<{ data: ImportResult; month: string | null } | null>(null)

  const go = (next: StepIndex, dateFormat = false) => {
    setNavigated(true)
    setFocusDateFormat(dateFormat)
    setAnnouncement('')
    setStep(next)
  }

  const load = useMutation({
    mutationFn: async (file: File) => {
      const text = await readCsvFile(file)
      return { file, text, inspect: await api.importCsv.inspect(text) }
    },
    onSuccess: ({ file, text, inspect }) => {
      const saved = loadMapping(inspect)
      setLoaded({ name: file.name, size: file.size, text, inspect, remembered: saved !== null })
      setForm(saved ?? guessForm(inspect.headers))
      setPreview(null)
      setPicks(noPicks())
      setResult(null)
      go(1)
    },
  })

  const previewM = useMutation({
    mutationFn: (v: { text: string; mapping: ImportMapping; form: MappingForm; headers: string[] }) =>
      api.importCsv.preview(v.text, v.mapping),
    onSuccess: (data, v) => {
      saveMapping(v.headers, v.form)
      setPreview({ key: JSON.stringify(v.mapping), data })
      setPicks(noPicks())
      go(2)
      const s = data.summary
      setAnnouncement(`Previsualización lista: ${count(s.total, 'fila', 'filas')}, ${count(s.valid, 'válida', 'válidas')}, ${count(s.duplicates, 'duplicada', 'duplicadas')}, ${nf.format(s.errors)} con error. Fechas leídas como ${DATE_FORMAT_NAME[data.date_format]}.`)
    },
  })

  const confirm = useMutation({
    mutationFn: (v: { text: string; mapping: ImportMapping; skip: number[]; categories: Picks['cats'] }) =>
      api.importCsv.confirm(v.text, v.mapping, v.skip, v.categories),
    onSuccess: (data, v) => {
      void qc.invalidateQueries({ queryKey: keys.all })
      // Movimientos se abre en el mes del movimiento más reciente que entró.
      const skip = new Set(v.skip)
      const latest = preview?.data.rows
        .filter((r) => isSelectable(r) && !skip.has(r.index))
        .reduce((max, r) => (r.occurred_on && r.occurred_on > max ? r.occurred_on : max), '')
      setResult({ data, month: latest ? latest.slice(0, 7) : null })
      go(3)
      setAnnouncement(`Importación terminada: ${count(data.inserted, 'importado', 'importados')}, ${count(data.duplicates, 'duplicado', 'duplicados')}, ${count(data.skipped, 'saltado', 'saltados')}.`)
    },
  })

  const mapping = form ? toMapping(form) : null
  const dateFormatError = isAmbiguousDate(previewM.error) ? previewM.error.message : null

  function submitMapping() {
    if (!loaded || !form || !mapping) return
    // Mismo fichero y mismo mapeo que la previsualización que ya hay: se conserva, con sus marcas.
    if (preview?.key === JSON.stringify(mapping)) return go(2)
    previewM.mutate({ text: loaded.text, mapping, form, headers: loaded.inspect.headers })
  }

  function submitConfirm() {
    if (!loaded || !mapping) return
    confirm.mutate({ text: loaded.text, mapping, skip: [...picks.off], categories: picks.cats })
  }

  function again() {
    setLoaded(null)
    setForm(null)
    setPreview(null)
    setPicks(noPicks())
    setResult(null)
    load.reset()
    go(0)
  }

  return (
    <div>
      <PageHeader title="Importar movimientos">
        <LinkButton to="/movimientos" variant="ghost">
          <ArrowLeft size={16} aria-hidden />Volver a Movimientos
        </LinkButton>
      </PageHeader>

      <Stepper current={step} />

      {step === 0 ? (
        <FileStep
          file={loaded && { name: loaded.name, size: loaded.size, delimiter: loaded.inspect.delimiter }}
          readingName={load.isPending ? load.variables.name : null}
          error={load.error}
          focusHeading={navigated}
          onFile={(f) => load.mutate(f)}
          onContinue={() => { load.reset(); go(1) }}
        />
      ) : null}

      {step === 1 && loaded && form ? (
        <MappingStep
          inspect={loaded.inspect}
          form={form}
          remembered={loaded.remembered}
          pending={previewM.isPending}
          error={dateFormatError ? null : previewM.error}
          dateFormatError={dateFormatError}
          focusHeading={navigated}
          focusDateFormat={focusDateFormat}
          onChange={(patch) => { previewM.reset(); setForm({ ...form, ...patch }) }}
          onBack={() => { previewM.reset(); go(0) }}
          onSubmit={submitMapping}
        />
      ) : null}

      {step === 2 && preview ? (
        <PreviewStep
          preview={preview.data}
          picks={picks}
          setPicks={setPicks}
          pending={confirm.isPending}
          error={confirm.error}
          focusHeading={navigated}
          onBack={() => { confirm.reset(); go(1) }}
          onEditDateFormat={() => { confirm.reset(); go(1, true) }}
          onConfirm={submitConfirm}
        />
      ) : null}

      {step === 3 && result ? (
        <ResultStep result={result.data} month={result.month} focusHeading={navigated} onAgain={again} />
      ) : null}

      {/* Una región aria-live breve: solo el resumen de la previsualización y el resultado. */}
      <p role="status" className="sr-only">{announcement}</p>
    </div>
  )
}
