import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Permission } from '@da/shared/rbac'
import { authApi, type Me } from '../services/api'

export const ME_QUERY_KEY = ['auth', 'me'] as const

/** Current session, straight from the backend. The UI never decides access on its own. */
export function useAuth() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ME_QUERY_KEY, queryFn: authApi.me, retry: false })
  const me: Me | null = query.data ?? null

  return {
    me,
    isLoading: query.isLoading,
    can: (permission: Permission) => me?.permissions.includes(permission) ?? false,
    refresh: () => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
    async logout() {
      await authApi.logout().catch(() => undefined)
      queryClient.setQueryData(ME_QUERY_KEY, null)
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
    },
  }
}
