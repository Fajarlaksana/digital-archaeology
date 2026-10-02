import type { Permission, RoleName } from '@da/shared/rbac'

export type HealthState = { ok: true; detail: string } | { ok: false; detail: string }

/** Calls a backend health endpoint and reduces the answer to ok / not ok. */
export async function checkHealth(
  path: '/health' | '/health/database' | '/health/rpc',
): Promise<HealthState> {
  try {
    const res = await fetch(path)
    const body: unknown = await res.json().catch(() => null)
    if (res.ok) {
      const status = (body as { status?: string } | null)?.status ?? 'ok'
      return { ok: status === 'ok', detail: status }
    }
    const code = (body as { error?: { code?: string } } | null)?.error?.code ?? `HTTP ${res.status}`
    return { ok: false, detail: code }
  } catch {
    return { ok: false, detail: 'tidak terhubung' }
  }
}

/** Error in the backend's standard format: { error: { code, message, request_id } }. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | null

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export async function apiFetch<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET'
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  if (res.status === 204) return undefined as T

  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const error = (
      body as { error?: { code?: string; message?: string; request_id?: string } } | null
    )?.error
    throw new ApiError(
      res.status,
      error?.code ?? `HTTP_${res.status}`,
      error?.message ?? 'Permintaan gagal',
      error?.request_id ?? null,
    )
  }
  return body as T
}

// ─── Types mirrored from the backend responses ───

export type SessionState = 'ACTIVE' | 'MFA_PENDING' | 'MFA_SETUP_REQUIRED'
export type UserStatus = 'ACTIVE' | 'DISABLED' | 'LOCKED'

export interface PublicUser {
  id: string
  email: string
  name: string
  roles: RoleName[]
  status: UserStatus
  mfaEnabled: boolean
  lastLoginAt: string | null
  createdAt: string
}

export interface Me {
  user: PublicUser
  sessionState: SessionState
  permissions: Permission[]
  reauthAt: string | null
}

export const authApi = {
  async me(): Promise<Me | null> {
    try {
      return await apiFetch<Me>('/api/auth/me')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null
      throw error
    }
  },
  login: (email: string, password: string) =>
    apiFetch<{ sessionState: SessionState }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  logout: () => apiFetch<void>('/api/auth/logout', { method: 'POST', body: {} }),
  verifyMfa: (code: string) =>
    apiFetch<{ sessionState: SessionState }>('/api/auth/mfa/verify', {
      method: 'POST',
      body: { code },
    }),
  startMfaSetup: () =>
    apiFetch<{ secret: string; otpauthUri: string }>('/api/auth/mfa/setup', {
      method: 'POST',
      body: {},
    }),
  enableMfa: (code: string) =>
    apiFetch<{ sessionState: SessionState }>('/api/auth/mfa/enable', {
      method: 'POST',
      body: { code },
    }),
}

export const usersApi = {
  list: () => apiFetch<{ users: PublicUser[] }>('/api/users').then((r) => r.users),
  create: (input: { email: string; name: string; password: string; roles: RoleName[] }) =>
    apiFetch<{ user: PublicUser }>('/api/users', { method: 'POST', body: input }).then(
      (r) => r.user,
    ),
  update: (id: string, input: { name?: string; roles?: RoleName[]; status?: UserStatus }) =>
    apiFetch<{ user: PublicUser }>(`/api/users/${id}`, { method: 'PATCH', body: input }).then(
      (r) => r.user,
    ),
}
