import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, keys } from '../../lib/api'
import { centsToInput, parseAmountToCents } from '../../lib/money'
import { todayISO } from '../../lib/dates'
import { Button, Dialog, Field, Segmented, TextInput } from '../../components/ui'
import { CategoryPicker } from './CategoryPicker'
import type { Category, Kind, Transaction, TransactionInput } from '../../lib/types'

interface FieldErrors {
  amount?: string
  date?: string
  description?: string
  general?: string
}

const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: 'expense', label: 'Gasto' },
  { value: 'income', label: 'Ingreso' },
]

/** Alta/edición de un movimiento. Alta: crea y opcionalmente sigue creando
 *  ("Guardar y añadir otro"). Edición: además permite borrar (dos pasos). */
export function TransactionDialog({ mode, transaction, categories, onClose, onSaved }: {
  mode: 'create' | 'edit'
  transaction?: Transaction
  categories: Category[]
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const qc = useQueryClient()
  const amountRef = useRef<HTMLInputElement>(null)

  const [kind, setKind] = useState<Kind>(transaction?.kind ?? 'expense')
  const [amountText, setAmountText] = useState(transaction ? centsToInput(transaction.amount_cents) : '')
  const [categoryId, setCategoryId] = useState<string | null>(transaction?.category_id ?? null)
  const [occurredOn, setOccurredOn] = useState(transaction?.occurred_on ?? todayISO())
  const [description, setDescription] = useState(transaction?.description ?? '')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [localFlash, setLocalFlash] = useState<string | null>(null)
  const [deleteStep, setDeleteStep] = useState<0 | 1>(0)

  useEffect(() => { amountRef.current?.focus() }, [])

  useEffect(() => {
    if (!localFlash) return
    const t = setTimeout(() => setLocalFlash(null), 2500)
    return () => clearTimeout(t)
  }, [localFlash])

  const invalidate = () => qc.invalidateQueries({ queryKey: keys.all })

  const createM = useMutation({
    mutationFn: (input: TransactionInput) => api.transactions.create(input),
    onSuccess: invalidate,
  })
  const updateM = useMutation({
    mutationFn: (input: Partial<TransactionInput>) => api.transactions.update(transaction!.id, input),
    onSuccess: invalidate,
  })
  const deleteM = useMutation({
    mutationFn: () => api.transactions.remove(transaction!.id),
    onSuccess: invalidate,
  })

  function handleKindChange(next: Kind) {
    setKind(next)
    const current = categories.find((c) => c.id === categoryId)
    if (current && current.kind !== next) setCategoryId(null)
  }

  async function handleSubmit(addAnother: boolean) {
    const cents = parseAmountToCents(amountText)
    const nextErrors: FieldErrors = {}
    if (cents === null) nextErrors.amount = 'Escribe un importe válido, por ejemplo 12,50'
    if (!occurredOn) nextErrors.date = 'Elige una fecha'
    if (description.length > 500) nextErrors.description = 'La descripción no puede superar los 500 caracteres'
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      if (nextErrors.amount) amountRef.current?.focus()
      return
    }
    setErrors({})
    const payload: TransactionInput = {
      kind,
      amount_cents: cents!,
      category_id: categoryId,
      occurred_on: occurredOn,
      description: description.trim() || null,
    }
    try {
      if (mode === 'create') {
        await createM.mutateAsync(payload)
        if (addAnother) {
          setAmountText('')
          setDescription('')
          setLocalFlash('Movimiento añadido')
          amountRef.current?.focus()
        } else {
          onSaved('Movimiento añadido')
        }
      } else {
        await updateM.mutateAsync(payload)
        onSaved('Cambios guardados')
      }
    } catch (e) {
      setErrors(fieldErrorsFromApi(e))
    }
  }

  async function handleDelete() {
    try {
      await deleteM.mutateAsync()
      onSaved('Movimiento borrado')
    } catch (e) {
      setErrors(fieldErrorsFromApi(e))
    }
  }

  const saving = createM.isPending || updateM.isPending
  const formId = useId()

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'create' ? 'Añadir movimiento' : 'Editar movimiento'}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          {mode === 'create' ? (
            <Button type="button" variant="secondary" loading={saving} onClick={() => handleSubmit(true)}>
              Guardar y añadir otro
            </Button>
          ) : null}
          {/* Botón de envío del <form> aunque viva en el pie del diálogo: así Enter envía. */}
          <Button type="submit" form={formId} loading={saving}>
            {mode === 'create' ? 'Añadir movimiento' : 'Guardar cambios'}
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void handleSubmit(false) }}>
        {errors.general ? (
          <p role="alert" className="text-sm text-over">{errors.general}</p>
        ) : null}
        {localFlash ? (
          <p role="status" className="text-sm text-savings-ink font-medium">{localFlash}</p>
        ) : null}

        <Segmented value={kind} onChange={handleKindChange} label="Tipo de movimiento" options={KIND_OPTIONS} />

        <Field label="Importe" error={errors.amount} hint={errors.amount ? undefined : 'Ej: 12,50'}>
          {(props) => (
            <TextInput
              {...props}
              ref={amountRef}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              className="text-lg tabular"
            />
          )}
        </Field>

        <CategoryPicker categories={categories} kind={kind} value={categoryId} onChange={setCategoryId} label="Categoría" />

        <Field label="Fecha" error={errors.date}>
          {(props) => (
            <TextInput {...props} type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
          )}
        </Field>

        <Field label="Descripción (opcional)" error={errors.description}>
          {(props) => (
            <TextInput
              {...props}
              value={description}
              maxLength={500}
              placeholder="Notas sobre este movimiento"
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>

        {mode === 'edit' ? (
          <div className="mt-1 pt-4 border-t border-rule flex items-center justify-between gap-3">
            <span className="text-sm text-ink-soft">Borrar este movimiento</span>
            {deleteStep === 0 ? (
              <Button type="button" variant="danger" size="sm" onClick={() => setDeleteStep(1)}>Borrar</Button>
            ) : (
              <div className="flex items-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => setDeleteStep(0)}>Cancelar</Button>
                <Button type="button" variant="danger" size="sm" loading={deleteM.isPending} onClick={() => void handleDelete()}>
                  Sí, borrar movimiento
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </form>
    </Dialog>
  )
}

function fieldErrorsFromApi(e: unknown): FieldErrors {
  if (!(e instanceof ApiError)) return { general: 'No se ha podido guardar. Inténtalo de nuevo.' }
  const msg = e.message.toLowerCase()
  if (msg.includes('importe') || msg.includes('amount')) return { amount: e.message }
  if (msg.includes('fecha') || msg.includes('date')) return { date: e.message }
  if (msg.includes('descripción') || msg.includes('description')) return { description: e.message }
  return { general: e.message }
}
