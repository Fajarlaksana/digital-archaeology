import { Route, Routes } from 'react-router'
import { Layout } from './components/Layout'
import { NAV_ITEMS } from './navigation'
import { DashboardPage } from './pages/DashboardPage'
import { PlaceholderPage } from './pages/PlaceholderPage'

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        {NAV_ITEMS.filter((item) => item.path !== '/').map((item) => (
          <Route key={item.path} path={item.path} element={<PlaceholderPage item={item} />} />
        ))}
        <Route path="*" element={<p className="text-slate-600">Halaman tidak ditemukan.</p>} />
      </Route>
    </Routes>
  )
}
