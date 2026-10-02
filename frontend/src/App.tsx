import { Navigate, Route, Routes } from 'react-router'
import { RequireAuth } from './auth/RequireAuth'
import { useAuth } from './auth/useAuth'
import { Layout } from './components/Layout'
import { NAV_ITEMS, type NavItem } from './navigation'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { MfaPage } from './pages/MfaPage'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { UsersPage } from './pages/UsersPage'

const PAGES: Record<string, () => React.JSX.Element> = {
  '/users': UsersPage,
}

/** Direct URL access to a page the user may not see sends them home (the API denies it anyway). */
function Guarded({ item }: { item: NavItem }) {
  const { can } = useAuth()
  if (item.permission && !can(item.permission)) return <Navigate to="/" replace />
  const Page = PAGES[item.path]
  return Page ? <Page /> : <PlaceholderPage item={item} />
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/mfa" element={<MfaPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          {NAV_ITEMS.filter((item) => item.path !== '/').map((item) => (
            <Route key={item.path} path={item.path} element={<Guarded item={item} />} />
          ))}
          <Route path="*" element={<p className="text-slate-600">Halaman tidak ditemukan.</p>} />
        </Route>
      </Route>
    </Routes>
  )
}
