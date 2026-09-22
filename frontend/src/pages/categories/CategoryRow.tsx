import { Pencil } from 'lucide-react'
import { CategoryIcon } from '../../lib/icons'
import { BUCKETS, BUCKET_ORDER } from '../../lib/buckets'
import { Button, Select, cx } from '../../components/ui'
import type { Bucket, Category } from '../../lib/types'

/** Icono en blanco sobre un círculo del color propio de la categoría. */
export function IconChip({ color, icon, size = 'md' }: { color: string; icon: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cx('inline-flex items-center justify-center rounded-full shrink-0', size === 'sm' ? 'size-7' : 'size-8')}
      style={{ backgroundColor: color }}
    >
      <CategoryIcon name={icon} size={size === 'sm' ? 14 : 16} className="text-white" />
    </span>
  )
}

/** Una fila de categoría: icono, nombre, selector de cubo (si es gasto activo)
 *  o botón de restaurar (si está archivada), y editar. */
export function CategoryRow({ category, onChangeBucket, bucketPending, onEdit, onRestore, restorePending }: {
  category: Category
  onChangeBucket?: (bucket: Bucket) => void
  bucketPending?: boolean
  onEdit: () => void
  onRestore?: () => void
  restorePending?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <IconChip color={category.color} icon={category.icon} size={onRestore ? 'sm' : 'md'} />
      <span className={cx('min-w-[6rem] flex-1 truncate text-[15px]', onRestore && 'text-ink-soft')}>
        {category.name}
      </span>
      {onChangeBucket && category.bucket ? (
        <div className="w-[11.5rem] shrink-0">
          <Select
            aria-label={`Cubo de ${category.name}`}
            value={category.bucket}
            disabled={bucketPending}
            onChange={(e) => onChangeBucket(e.target.value as Bucket)}
          >
            {BUCKET_ORDER.map((b) => <option key={b} value={b}>{BUCKETS[b].label}</option>)}
          </Select>
        </div>
      ) : null}
      {onRestore ? (
        <Button size="sm" variant="secondary" onClick={onRestore} loading={restorePending}>
          Restaurar
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Editar ${category.name}`}>
        <Pencil size={16} />
      </Button>
    </div>
  )
}
