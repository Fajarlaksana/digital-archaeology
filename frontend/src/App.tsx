import { Navigate, Route, Routes } from 'react-router'
import type { Permission } from '@da/shared/rbac'
import { RequireAuth } from './auth/RequireAuth'
import { useAuth } from './auth/useAuth'
import { Layout } from './components/Layout'
import { NAV_ITEMS, type NavItem } from './navigation'
import { AddressDetailPage } from './pages/AddressDetailPage'
import { AddressesPage } from './pages/AddressesPage'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { MfaPage } from './pages/MfaPage'
import { NetworksPage } from './pages/NetworksPage'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { ScanDetailPage } from './pages/ScanDetailPage'
import { ScansPage } from './pages/ScansPage'
import { UsersPage } from './pages/UsersPage'

const PAGES: Record<string, () => React.JSX.Element> = {
  '/users': UsersPage,
  '/networks': NetworksPage,
  '/addresses': AddressesPage,
  '/scans': ScansPage,
}

/** Direct URL access to a page the user may not see sends them home (the API denies it anyway). */
function Guarded({ item }: { item: NavItem }) {
  const { can } = useAuth()
  if (item.permission && !can(item.permission)) return <Navigate to="/" replace />
  const Page = PAGES[item.path]
  return Page ? <Page /> : <PlaceholderPage item={item} />
}

function RequirePermission({
  permission,
  children,
}: {
  permission: Permission
  children: React.ReactNode
}) {
  const { can } = useAuth()
  return can(permission) ? children : <Navigate to="/" replace />
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/mfa" element={<MfaPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route
            path="/addresses/:id"
            element={
              <RequirePermission permission="addresses:read">
                <AddressDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="/scans/:id"
            element={
              <RequirePermission permission="scans:read">
                <ScanDetailPage />
              </RequirePermission>
            }
          />
          {NAV_ITEMS.filter((item) => item.path !== '/').map((item) => (
            <Route key={item.path} path={item.path} element={<Guarded item={item} />} />
          ))}
          <Route path="*" element={<p className="text-slate-600">Halaman tidak ditemukan.</p>} />
        </Route>
      </Route>
    </Routes>
  )
}
