import { Button, LinkButton } from '../../components/ui'
import type { ImportResult } from '../../lib/types'
import { StepHeading } from './Steps'

const nf = new Intl.NumberFormat('es-ES')

/** Paso 4: cuántos movimientos entraron y cuántos no. */
export function ResultStep({ result, month, focusHeading, onAgain }: {
  result: ImportResult
  /** Mes (YYYY-MM) del movimiento más reciente importado, para abrir Movimientos ahí. */
  month: string | null
  focusHeading: boolean
  onAgain: () => void
}) {
  const { inserted, duplicates, skipped } = result
  return (
    <section className="max-w-3xl">
      <StepHeading focus={focusHeading}>
        {inserted === 0
          ? 'No se ha importado ningún movimiento'
          : inserted === 1 ? 'Se ha importado 1 movimiento' : `Se han importado ${nf.format(inserted)} movimientos`}
      </StepHeading>
      <p className="text-ink-soft mb-6">
        {inserted > 0
          ? 'Ya aparecen en Movimientos y cuentan en el reparto 50/30/20.'
          : 'Todo lo del fichero ya estaba importado o se ha dejado fuera.'}
      </p>

      <dl className="max-w-md mb-8 rounded-[var(--radius-panel)] border border-grid bg-sheet text-[15px]">
        <Row label="Importados" value={inserted} />
        <Row label="Duplicados, ya estaban" value={duplicates} />
        <Row label="Saltados, los que desmarcaste" value={skipped} />
      </dl>

      <div className="flex flex-wrap gap-2">
        <LinkButton to={month ? `/movimientos?mes=${month}` : '/movimientos'}>Ver movimientos</LinkButton>
        <Button variant="secondary" onClick={onAgain}>Importar otro fichero</Button>
      </div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3 border-b border-rule last:border-0">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="font-semibold tabular">{nf.format(value)}</dd>
    </div>
  )
}
