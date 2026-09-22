import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Plus } from 'lucide-react'
import { Button, EmptyState, ErrorNote, PageHeader, Skeleton, cx } from '../components/ui'
import { api, ApiError, keys } from '../lib/api'
import { BUCKETS, BUCKET_ORDER } from '../lib/buckets'
import type { Bucket, Category, CategoryInput, Kind } from '../lib/types'
import { CategoryFormDialog } from './categories/CategoryFormDialog'
import { CategoryRow } from './categories/CategoryRow'

type DialogState =
  | { mode: 'create'; kind?: Kind; bucket?: Bucket }
  | { mode: 'edit'; category: Category }
  | null

export default function CategoriesPage() {
  const queryClient = useQueryClient()
  const { data: categories, isLoading, isError, error, refetch } = useQuery({
    queryKey: keys.categories(true),
    queryFn: () => api.categories.list(true),
  })

  const [dialog, setDialog] = useState<DialogState>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  const groups = useMemo(() => {
    const active = (categories ?? []).filter((c) => !c.is_archived)
    const archived = (categories ?? []).filter((c) => c.is_archived)
    const income = active.filter((c) => c.kind === 'income')
    const byBucket: Record<Bucket, Category[]> = { needs: [], wants: [], savings: [] }
    for (const c of active) if (c.kind === 'expense' && c.bucket) byBucket[c.bucket].push(c)
    return { income, byBucket, archived }
  }, [categories])

  const bucketMutation = useMutation({
    mutationFn: ({ id, bucket }: { id: string; bucket: Bucket }) =>
      api.categories.update(id, { bucket }),
    onMutate: async ({ id, bucket }) => {
      await queryClient.cancelQueries({ queryKey: keys.categories(true) })
      const previous = queryClient.getQueryData<Category[]>(keys.categories(true))
      queryClient.setQueryData<Category[]>(keys.categories(true), (old) =>
        old?.map((c) => (c.id === id ? { ...c, bucket } : c)))
      return { previous }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(keys.categories(true), ctx.previous)
      setToast(err instanceof ApiError ? err.message : 'No se pudo mover la categoría.')
    },
    onSuccess: (_data, vars) => setToast(`Movida a ${BUCKETS[vars.bucket].label}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  })

  const createMutation = useMutation({
    mutationFn: (input: CategoryInput) => api.categories.create(input),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: keys.all }); setDialog(null) },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<CategoryInput> }) =>
      api.categories.update(id, patch),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: keys.all }); setDialog(null) },
  })

  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.categories.update(id, { is_archived: archived }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: keys.all })
      setToast(vars.archived ? 'Categoría archivada' : 'Categoría restaurada')
      setDialog(null)
    },
  })

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.categories.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.all })
      setToast('Categoría borrada')
      setDialog(null)
    },
  })

  const editing = dialog?.mode === 'edit' ? dialog.category : null
  const submitting = createMutation.isPending || updateMutation.isPending
  const submitError = (editing ? updateMutation.error : createMutation.error) as ApiError | null

  function handleSubmit(input: CategoryInput) {
    createMutation.reset()
    updateMutation.reset()
    if (editing) updateMutation.mutate({ id: editing.id, patch: input })
    else createMutation.mutate(input)
  }

  function handleRestoreFromList(id: string) {
    archiveMutation.mutate({ id, archived: false })
  }

  return (
    <div>
      <PageHeader title="Categorías">
        <Button onClick={() => setDialog({ mode: 'create' })}>
          <Plus size={18} aria-hidden /> Nueva categoría
        </Button>
      </PageHeader>

      <p className="text-ink-soft mb-8 max-w-2xl">
        De cada ingreso, el 50 % va a necesidades, el 30 % a deseos y el 20 % a ahorro; lo que no
        gastas también cuenta como ahorro. Aquí decides a qué cubo pertenece cada categoría.
      </p>

      {isLoading ? (
        <div className="flex flex-col gap-8">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-3">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <ErrorNote error={error} onRetry={() => refetch()} />
      ) : (categories ?? []).length === 0 ? (
        <EmptyState title="Todavía no hay categorías">
          <p>Crea la primera categoría para empezar a repartir tus movimientos por cubos.</p>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-10">
          {BUCKET_ORDER.map((bucket) => (
            <BucketSection
              key={bucket}
              bucket={bucket}
              categories={groups.byBucket[bucket]}
              onAdd={() => setDialog({ mode: 'create', kind: 'expense', bucket })}
              onChangeBucket={(id, b) => bucketMutation.mutate({ id, bucket: b })}
              bucketPendingId={bucketMutation.isPending ? bucketMutation.variables?.id : undefined}
              onEdit={(category) => setDialog({ mode: 'edit', category })}
            />
          ))}

          <IncomeSection
            categories={groups.income}
            onAdd={() => setDialog({ mode: 'create', kind: 'income' })}
            onEdit={(category) => setDialog({ mode: 'edit', category })}
          />

          {groups.archived.length > 0 ? (
            <details className="group">
              <summary className="flex items-center gap-1.5 cursor-pointer select-none text-sm font-medium text-ink-soft hover:text-ink w-fit">
                <ChevronDown size={16} className="transition-transform group-open:rotate-180" aria-hidden />
                Archivadas ({groups.archived.length})
              </summary>
              <div className="mt-3 pl-4 divide-y divide-rule border-l-[3px] border-grid">
                {groups.archived.map((c) => (
                  <CategoryRow
                    key={c.id}
                    category={c}
                    onEdit={() => setDialog({ mode: 'edit', category: c })}
                    onRestore={() => handleRestoreFromList(c.id)}
                    restorePending={archiveMutation.isPending && archiveMutation.variables?.id === c.id}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}

      <CategoryFormDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        category={editing}
        presetKind={dialog?.mode === 'create' ? dialog.kind : undefined}
        presetBucket={dialog?.mode === 'create' ? dialog.bucket ?? null : undefined}
        onSubmit={handleSubmit}
        submitting={submitting}
        submitError={submitError}
        onArchive={() => editing && archiveMutation.mutate({ id: editing.id, archived: true })}
        onRestore={() => editing && archiveMutation.mutate({ id: editing.id, archived: false })}
        onDelete={() => editing && removeMutation.mutate(editing.id)}
        archivePending={archiveMutation.isPending}
        deletePending={removeMutation.isPending}
      />

      {toast ? (
        <div
          role="status"
          className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 md:left-auto md:right-6 md:translate-x-0 bg-ink text-white text-sm px-4 py-2.5 rounded-[var(--radius-control)] shadow-[var(--shadow-lift)] z-20"
        >
          {toast}
        </div>
      ) : null}
    </div>
  )
}

/** Un grupo de gastos (Necesidades/Deseos/Ahorro): filete del color del cubo,
 *  como una sección de la libreta, no una tarjeta con sombra. */
function BucketSection({ bucket, categories, onAdd, onChangeBucket, bucketPendingId, onEdit }: {
  bucket: Bucket
  categories: Category[]
  onAdd: () => void
  onChangeBucket: (id: string, bucket: Bucket) => void
  bucketPendingId?: string
  onEdit: (category: Category) => void
}) {
  const b = BUCKETS[bucket]
  const headingId = `grupo-${bucket}`
  return (
    <section aria-labelledby={headingId}>
      <div className={cx('border-l-[3px] pl-4', `border-${bucket}`)}>
        <h2 id={headingId} className="text-lg font-semibold">
          {b.label} <span className="text-sm font-normal text-ink-soft">{b.pct} %</span>
        </h2>
        <p className="text-sm text-ink-soft mt-0.5">{b.hint}</p>
      </div>
      <div className="mt-3 pl-4 divide-y divide-rule">
        {categories.length === 0 ? (
          <p className="py-2.5 text-sm text-ink-soft">Todavía no hay categorías en este cubo.</p>
        ) : categories.map((c) => (
          <CategoryRow
            key={c.id}
            category={c}
            onChangeBucket={(nb) => onChangeBucket(c.id, nb)}
            bucketPending={bucketPendingId === c.id}
            onEdit={() => onEdit(c)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="mt-2 ml-4 flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink"
      >
        <Plus size={16} aria-hidden /> Añadir categoría
      </button>
    </section>
  )
}

function IncomeSection({ categories, onAdd, onEdit }: {
  categories: Category[]
  onAdd: () => void
  onEdit: (category: Category) => void
}) {
  return (
    <section aria-labelledby="grupo-income">
      <div className="border-l-[3px] border-income pl-4">
        <h2 id="grupo-income" className="text-lg font-semibold">Ingresos</h2>
        <p className="text-sm text-ink-soft mt-0.5">Nómina, extras y cualquier otro dinero que entra.</p>
      </div>
      <div className="mt-3 pl-4 divide-y divide-rule">
        {categories.length === 0 ? (
          <p className="py-2.5 text-sm text-ink-soft">Todavía no hay categorías de ingreso.</p>
        ) : categories.map((c) => (
          <CategoryRow key={c.id} category={c} onEdit={() => onEdit(c)} />
        ))}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="mt-2 ml-4 flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink"
      >
        <Plus size={16} aria-hidden /> Añadir categoría
      </button>
    </section>
  )
}
