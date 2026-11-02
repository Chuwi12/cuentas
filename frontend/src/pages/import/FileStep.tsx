import { useRef, useState } from 'react'
import { FileText, Upload } from 'lucide-react'
import { Button, ErrorNote, cx } from '../../components/ui'
import { delimiterName, formatBytes } from './readCsv'
import { StepHeading } from './Steps'

export interface LoadedFile {
  name: string
  size: number
  delimiter: string
}

/** Paso 1: elegir el CSV, con el selector o arrastrándolo. Al elegirlo se lee e inspecciona solo. */
export function FileStep({ file, readingName, error, focusHeading, onFile, onContinue }: {
  /** El fichero ya leído, si se vuelve a este paso desde otro. */
  file: LoadedFile | null
  /** Nombre del fichero que se está leyendo ahora (null si no hay lectura en curso). */
  readingName: string | null
  error: unknown
  focusHeading: boolean
  onFile: (file: File) => void
  onContinue: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const pick = () => inputRef.current?.click()

  return (
    <section className="max-w-3xl" aria-busy={readingName !== null}>
      <StepHeading focus={focusHeading}>Elige el fichero de tu banco</StepHeading>
      <p className="text-ink-soft max-w-[68ch] mb-6">
        Vale el CSV de cualquier banco. En el siguiente paso indicas qué columna es cada dato.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = '' // permite volver a elegir el mismo fichero tras un error
          if (f) onFile(f)
        }}
      />

      {error ? <div className="mb-4"><ErrorNote error={error} /></div> : null}

      {readingName !== null ? (
        <div className="flex items-center gap-3 px-5 py-8 rounded-[var(--radius-panel)] border border-grid bg-sheet" role="status">
          <span className="size-5 rounded-full border-2 border-ink border-r-transparent animate-spin" aria-hidden />
          <span>Leyendo <span className="font-medium break-all">{readingName}</span>…</span>
        </div>
      ) : file ? (
        <>
          <div className="flex items-center gap-4 px-5 py-4 rounded-[var(--radius-panel)] border border-grid bg-sheet">
            <FileText size={24} strokeWidth={1.75} className="shrink-0 text-ink-soft" aria-hidden />
            <div className="min-w-0">
              <p className="font-medium break-all">{file.name}</p>
              <p className="text-sm text-ink-soft">{formatBytes(file.size)}, separador: {delimiterName(file.delimiter)}</p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={pick}>Elegir otro fichero</Button>
            <Button onClick={onContinue}>Continuar</Button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={pick}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false) }}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            const f = e.dataTransfer.files[0]
            if (f) onFile(f)
          }}
          className={cx(
            'w-full flex flex-col items-center gap-2 px-6 py-14 text-center rounded-[var(--radius-panel)]',
            'border-2 border-dashed transition-colors',
            over ? 'border-needs bg-needs-soft' : 'border-grid bg-sheet hover:border-ink-faint',
          )}
        >
          <Upload size={28} strokeWidth={1.75} className="text-ink-soft" aria-hidden />
          <span className="text-lg font-semibold">Arrastra aquí el CSV</span>
          <span className="text-ink-soft">o <span className="font-medium text-ink underline underline-offset-4">elige un fichero</span> de tu equipo</span>
          <span className="text-sm text-ink-soft mt-2">Hasta 2 MB y 5.000 filas</span>
        </button>
      )}
    </section>
  )
}
