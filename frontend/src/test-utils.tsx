import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { vi } from 'vitest'
import type { Permission, RoleName } from '@da/shared/rbac'
import { App } from './App'
import type { Me, PublicUser, SessionState } from './services/api'

export function user(roles: RoleName[], overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: crypto.randomUUID(),
    email: `${roles[0]?.toLowerCase()}@dev.local`,
    name: `Dev ${roles[0]}`,
    roles,
    status: 'ACTIVE',
    mfaEnabled: false,
    lastLoginAt: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}

export function session(
  role: RoleName,
  permissions: Permission[],
  sessionState: SessionState = 'ACTIVE',
): Me {
  return { user: user([role]), sessionState, permissions, reauthAt: null }
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Handler = (body: unknown) => Response

/**
 * Fake backend. Routes are "METHOD /path" (exact, including query string) or "METHOD /path*"
 * to match any query string. Returns the mock so tests can inspect calls.
 */
export function mockBackend(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    const key = `${method} ${url}`
    if (key.startsWith('GET /health')) return json(200, { status: 'ok' })
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const handler = routes[key] ?? routes[`${method} ${url.split('?')[0]}*`]
    return handler ? handler(body) : json(404, { error: { code: 'NOT_FOUND', message: key } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

export function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
