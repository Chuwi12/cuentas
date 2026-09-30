import { formatDateNumeric } from '../../lib/dates'
import { Money } from '../../components/ui'
import type { ReportTopTransaction } from '../../lib/types'

export function TopTransactions({ items }: { items: ReportTopTransaction[] }) {
  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Mayores movimientos</h2>
      {items.length === 0 ? (
        <p className="text-sm text-ink-soft">Sin movimientos en el periodo.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-grid text-left text-ink-soft">
                <th scope="col" className="py-2 pr-3 font-medium">Fecha</th>
                <th scope="col" className="py-2 pr-3 font-medium">Descripción</th>
                <th scope="col" className="py-2 pr-3 font-medium">Categoría</th>
                <th scope="col" className="py-2 font-medium text-right">Importe</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="border-b border-rule last:border-0">
                  <td className="py-2 pr-3 tabular whitespace-nowrap">{formatDateNumeric(t.occurred_on)}</td>
                  <td className="py-2 pr-3 min-w-40">{t.description ?? <span className="text-ink-soft">Sin descripción</span>}</td>
                  <td className="py-2 pr-3 min-w-36">
                    <span className="flex items-center gap-2">
                      <span className="size-2.5 rounded-full shrink-0" style={{ background: t.category_color ?? '#9ca3af' }} aria-hidden />
                      {t.category_name ?? 'Sin categoría'}
                    </span>
                  </td>
                  <td className="py-2 text-right"><Money cents={t.amount_cents} kind={t.kind} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
