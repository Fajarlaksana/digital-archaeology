import { Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from './useAuth'

/** Gate for every app page: logged in AND MFA completed. */
export function RequireAuth() {
  const { me, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return <p className="p-8 text-sm text-slate-500">Memuat sesi…</p>
  }
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (me.sessionState !== 'ACTIVE') return <Navigate to="/mfa" replace />
  return <Outlet />
}
