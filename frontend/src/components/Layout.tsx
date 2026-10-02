import { NavLink, Outlet, useNavigate } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { NAV_GROUPS } from '../navigation'

export function Layout() {
  const { me, can, logout } = useAuth()
  const navigate = useNavigate()

  // Menu shows only what the user may open; the backend enforces the same rules.
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.permission || can(item.permission)),
  })).filter((group) => group.items.length > 0)

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <p className="text-sm font-semibold">Digital Archaeology</p>
          <p className="text-xs text-slate-500">Testnet</p>
        </div>
        <nav aria-label="Menu utama" className="flex-1 space-y-6 px-3 py-4">
          {groups.map((group) => (
            <div key={group.title}>
              <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
                {group.title}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      end={item.path === '/'}
                      className={({ isActive }) =>
                        `block rounded-md px-2 py-1.5 text-sm ${
                          isActive
                            ? 'bg-slate-900 font-medium text-white'
                            : 'text-slate-700 hover:bg-slate-100'
                        }`
                      }
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        {me && (
          <div className="border-t border-slate-200 px-5 py-4 text-sm">
            <p className="truncate font-medium" title={me.user.email}>
              {me.user.name}
            </p>
            <p className="truncate text-xs text-slate-500">{me.user.roles.join(', ')}</p>
            <button
              type="button"
              onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
              className="mt-2 text-xs text-slate-500 hover:text-slate-900"
            >
              Keluar
            </button>
          </div>
        )}
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  )
}
