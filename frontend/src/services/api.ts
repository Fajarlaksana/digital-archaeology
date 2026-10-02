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

// ─── Networks (Phase 4) ───

export interface PublicAsset {
  id: string
  symbol: string
  name: string
  decimals: number
  isNative: boolean
  contractAddress: string | null
}

export interface PublicNetwork {
  id: string
  name: string
  displayName: string
  chainType: 'EVM' | 'BITCOIN'
  chainId: number | null
  isTestnet: boolean
  rpcUrlEnv: string | null
  rpcConfigured: boolean
  explorerUrl: string | null
  status: 'ACTIVE' | 'DISABLED'
  assets: PublicAsset[]
}

export interface NewNetworkInput {
  name: string
  displayName: string
  chainType: 'EVM'
  chainId: number
  isTestnet: boolean
  rpcUrlEnv: string | null
  explorerUrl: string | null
  nativeAsset: { symbol: string; name: string; decimals: number }
}

export const networksApi = {
  list: () => apiFetch<{ networks: PublicNetwork[] }>('/api/networks').then((r) => r.networks),
  create: (input: NewNetworkInput) =>
    apiFetch<{ network: PublicNetwork }>('/api/networks', { method: 'POST', body: input }).then(
      (r) => r.network,
    ),
  update: (
    id: string,
    input: Partial<Pick<PublicNetwork, 'displayName' | 'rpcUrlEnv' | 'explorerUrl' | 'status'>>,
  ) =>
    apiFetch<{ network: PublicNetwork }>(`/api/networks/${id}`, {
      method: 'PATCH',
      body: input,
    }).then((r) => r.network),
  addToken: (
    networkId: string,
    input: { contractAddress: string; symbol: string; name: string; decimals: number },
  ) =>
    apiFetch<{ asset: PublicAsset }>(`/api/networks/${networkId}/assets`, {
      method: 'POST',
      body: input,
    }).then((r) => r.asset),
}

// ─── Addresses (Phase 4) ───

export interface PublicAddress {
  id: string
  network: { id: string; name: string; displayName: string }
  address: string
  label: string | null
  ownerReference: string
  activityStatus: 'UNKNOWN' | 'ACTIVE' | 'INACTIVE'
  balanceStatus: 'UNKNOWN' | 'EMPTY' | 'HAS_BALANCE'
  authorizationStatus: string
  recoveryStatus: string
  reviewFlag: boolean
  lastActivityAt: string | null
  inactiveDays: number | null
  lastScannedAt: string | null
  archivedAt: string | null
  createdAt: string
  explorerUrl: string | null
}

export interface AddressPage {
  items: PublicAddress[]
  total: number
  page: number
  pageSize: number
}

export interface AddressQuery {
  networkId?: string
  search?: string
  archived?: 'exclude' | 'include' | 'only'
  page?: number
  pageSize?: number
}

export type ImportRowResult =
  | {
      line: number
      status: 'VALID'
      input: { address: string; network: string; label: string; ownerReference: string }
      address: string
    }
  | {
      line: number
      status: 'REJECTED'
      input: { address: string; network: string; label: string; ownerReference: string }
      reason: string
      message: string
    }

export interface ImportSummary {
  total: number
  valid: number
  rejected: number
  byReason: Record<string, number>
}

export const addressesApi = {
  list(query: AddressQuery) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    return apiFetch<AddressPage>(`/api/addresses?${params.toString()}`)
  },
  get: (id: string) =>
    apiFetch<{ address: PublicAddress }>(`/api/addresses/${id}`).then((r) => r.address),
  create: (input: {
    networkId: string
    address: string
    label: string | null
    ownerReference: string
  }) =>
    apiFetch<{ address: PublicAddress }>('/api/addresses', { method: 'POST', body: input }).then(
      (r) => r.address,
    ),
  update: (id: string, input: { label?: string | null; ownerReference?: string }) =>
    apiFetch<{ address: PublicAddress }>(`/api/addresses/${id}`, {
      method: 'PATCH',
      body: input,
    }).then((r) => r.address),
  archive: (id: string, reason: string | null) =>
    apiFetch<{ address: PublicAddress }>(`/api/addresses/${id}/archive`, {
      method: 'POST',
      body: { reason },
    }).then((r) => r.address),
  restore: (id: string) =>
    apiFetch<{ address: PublicAddress }>(`/api/addresses/${id}/restore`, {
      method: 'POST',
      body: {},
    }).then((r) => r.address),
  previewImport: (csv: string) =>
    apiFetch<{ summary: ImportSummary; results: ImportRowResult[] }>(
      '/api/addresses/import/preview',
      {
        method: 'POST',
        body: { csv },
      },
    ),
  commitImport: (csv: string) =>
    apiFetch<{ summary: ImportSummary; created: number; results: ImportRowResult[] }>(
      '/api/addresses/import',
      { method: 'POST', body: { csv } },
    ),
}
