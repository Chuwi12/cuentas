import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { Button, Dialog, Field, Segmented, TextInput, cx } from '../../components/ui'
import { ApiError } from '../../lib/api'
import { BUCKETS, BUCKET_ORDER } from '../../lib/buckets'
import { CATEGORY_ICONS, CategoryIcon } from '../../lib/icons'
import type { Bucket, Category, CategoryInput, Kind } from '../../lib/types'
import { IconChip } from './CategoryRow'
import { iconLabel } from './iconLabels'
import { CATEGORY_COLORS, DEFAULT_CATEGORY_COLOR } from './palette'
import { RadioGrid } from './RadioGrid'

const ICON_NAMES = Object.keys(CATEGORY_ICONS)
const DEFAULT_ICON = 'circle'

export function CategoryFormDialog({
  open, onClose, category, presetKind, presetBucket, onSubmit, submitting, submitError,
  onArchive, onRestore, onDelete, archivePending, deletePending,
}: {
  open: boolean
  onClose: () => void
  /** null = crear. */
  category: Category | null
  presetKind?: Kind
  presetBucket?: Bucket | null
  onSubmit: (input: CategoryInput) => void
  submitting: boolean
  submitError: ApiError | null
  onArchive?: () => void
  onRestore?: () => void
  onDelete?: () => void
  archivePending?: boolean
  deletePending?: boolean
}) {
  const [kind, setKind] = useState<Kind>('expense')
  const [name, setName] = useState('')
  const [bucket, setBucket] = useState<Bucket>('needs')
  const [color, setColor] = useState(DEFAULT_CATEGORY_COLOR)
  const [icon, setIcon] = useState(DEFAULT_ICON)
  const [nameError, setNameError] = useState<string | null>(null)
  const [bucketError, setBucketError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!open) return
    if (category) {
      setKind(category.kind)
      setName(category.name)
      setBucket(category.bucket ?? 'needs')
      setColor(category.color)
      setIcon(category.icon)
    } else {
      setKind(presetKind ?? 'expense')
      setName('')
      setBucket(presetBucket ?? 'needs')
      setColor(DEFAULT_CATEGORY_COLOR)
      setIcon(DEFAULT_ICON)
    }
    setNameError(null)
    setBucketError(null)
    setConfirmDelete(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, category?.id])

  const conflictError = submitError?.code === 'conflict' ? submitError.message : null
  const genericError = submitError && submitError.code !== 'conflict' ? submitError.message : null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    let ok = true
    if (trimmed.length < 1 || trimmed.length > 60) {
      setNameError('El nombre debe tener entre 1 y 60 caracteres.')
      ok = false
    } else {
      setNameError(null)
    }
    if (kind === 'expense' && !bucket) {
      setBucketError('Elige un cubo.')
      ok = false
    } else {
      setBucketError(null)
    }
    if (!ok) return
    onSubmit({ name: trimmed, kind, bucket: kind === 'expense' ? bucket : null, color, icon })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={category ? 'Editar categoría' : 'Nueva categoría'}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="category-form" loading={submitting}>
            {category ? 'Guardar cambios' : 'Crear categoría'}
          </Button>
        </>
      }
    >
      <form id="category-form" onSubmit={handleSubmit} className="flex flex-col gap-5">
        {category ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Tipo</span>
            <p className="text-[15px]">{category.kind === 'income' ? 'Ingreso' : 'Gasto'}</p>
            <p className="text-sm text-ink-soft">
              El tipo no se puede cambiar. Crea una categoría nueva si necesitas otro tipo.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Tipo</span>
            <Segmented<Kind>
              label="Tipo"
              value={kind}
              onChange={(v) => { setKind(v); if (v === 'income') setBucketError(null) }}
              options={[{ value: 'expense', label: 'Gasto' }, { value: 'income', label: 'Ingreso' }]}
            />
          </div>
        )}

        <Field label="Nombre" error={nameError} hint={nameError ? undefined : 'Hasta 60 caracteres.'}>
          {(props) => (
            <TextInput
              {...props}
              value={name}
              maxLength={60}
              placeholder="p. ej. Comida"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        {conflictError ? <p className="text-sm text-over -mt-3">{conflictError}</p> : null}

        {kind === 'expense' ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Cubo</span>
            <Segmented<Bucket>
              label="Cubo"
              value={bucket}
              onChange={setBucket}
              options={BUCKET_ORDER.map((b) => ({ value: b, label: BUCKETS[b].label }))}
            />
            {bucketError
              ? <p className="text-sm text-over">{bucketError}</p>
              : <p className="text-sm text-ink-soft">{BUCKETS[bucket].hint}</p>}
          </div>
        ) : null}

        <RadioGrid<string>
          legend="Color"
          columns={6}
          value={color}
          onChange={setColor}
          options={CATEGORY_COLORS.map((c) => ({
            value: c.hex,
            label: c.name,
            render: (selected) => (
              <span
                className="flex items-center justify-center size-8 rounded-full"
                style={{
                  backgroundColor: c.hex,
                  boxShadow: selected ? `0 0 0 2px var(--color-sheet), 0 0 0 4px ${c.hex}` : undefined,
                }}
              >
                {selected ? <Check size={16} className="text-white" strokeWidth={3} /> : null}
              </span>
            ),
          }))}
        />

        <RadioGrid<string>
          legend="Icono"
          columns={6}
          value={icon}
          onChange={setIcon}
          options={ICON_NAMES.map((name2) => ({
            value: name2,
            label: iconLabel(name2),
            render: (selected) => (
              <span className={cx(
                'flex items-center justify-center size-9 rounded-md border',
                selected ? 'border-ink bg-rule' : 'border-grid bg-sheet',
              )}>
                <CategoryIcon name={name2} size={18} className={selected ? 'text-ink' : 'text-ink-soft'} />
              </span>
            ),
          }))}
        />

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">Vista previa</span>
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-control)] border border-grid bg-paper">
            <IconChip color={color} icon={icon} />
            <span className="flex-1 min-w-0 truncate text-[15px] font-medium">{name || 'Nombre de la categoría'}</span>
            {kind === 'expense' ? (
              <span className={cx('text-xs font-medium px-2 py-1 rounded', BUCKETS[bucket].soft, BUCKETS[bucket].text)}>
                {BUCKETS[bucket].label}
              </span>
            ) : (
              <span className="text-xs font-medium text-ink-soft">Ingreso</span>
            )}
          </div>
        </div>

        {genericError ? <p role="alert" className="text-sm text-over">{genericError}</p> : null}
      </form>

      {category ? (
        <div className="mt-5 pt-4 border-t border-rule flex flex-col gap-3">
          <p className="text-sm font-medium text-ink">Zona de riesgo</p>
          {!confirmDelete ? (
            <div className="flex flex-wrap gap-2">
              {category.is_archived ? (
                <Button type="button" size="sm" variant="secondary" onClick={onRestore} loading={archivePending}>
                  Restaurar categoría
                </Button>
              ) : (
                <Button type="button" size="sm" variant="secondary" onClick={onArchive} loading={archivePending}>
                  Archivar
                </Button>
              )}
              <Button type="button" size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                Borrar
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 p-3 rounded-[var(--radius-control)] bg-over-soft">
              <p className="text-sm text-over">
                Los movimientos que usan "{category.name}" se quedarán sin categoría y dejarán de
                contar en su cubo. Si solo quieres dejar de usarla, mejor archívala: así conservas
                el histórico.
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>
                  Cancelar
                </Button>
                <Button type="button" size="sm" variant="danger" onClick={onDelete} loading={deletePending}>
                  Sí, borrar categoría
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  )
}
