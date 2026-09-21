import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, keys } from './api'
import type { User } from './types'

/**
 * Sesión actual. `user` es null si no hay sesión (401), undefined mientras carga.
 * No hay token en JS: la sesión vive en una cookie httpOnly que gestiona el backend.
 */
export function useSession() {
  const q = useQuery({
    queryKey: keys.me,
    queryFn: async (): Promise<User | null> => {
      try {
        return (await api.auth.me()).user
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
  return { user: q.data, isLoading: q.isLoading, error: q.error }
}

/** Tras login/registro/logout: fija la sesión y tira todo lo demás de la caché. */
export function useSetSession() {
  const qc = useQueryClient()
  return (user: User | null) => {
    qc.removeQueries({ queryKey: keys.all, predicate: (q) => q.queryKey[1] !== 'me' })
    qc.setQueryData(keys.me, user)
  }
}
