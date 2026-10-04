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
  /** CoinGecko id used for valuation. */
  priceId: string | null
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
  recoveryStatus: RecoveryStatus
  /** Eligibility reason codes (Phase 8b), most relevant first. */
  recoveryReasons: string[]
  eligibilityCheckedAt: string | null
  reviewFlag: boolean
  lastActivityAt: string | null
  inactiveDays: number | null
  lastScannedAt: string | null
  archivedAt: string | null
  createdAt: string
  explorerUrl: string | null
  /** ESTIMATE in fiatCurrency; null when nothing is priced. */
  estimatedValue: string | null
  fiatCurrency: string
  /** Testnet: priced with mainnet prices — not real money. */
  valueSimulated: boolean
}

export interface AddressPage {
  items: PublicAddress[]
  total: number
  page: number
  pageSize: number
}

export type RecoveryStatus =
  'NONE' | 'NOT_ELIGIBLE' | 'NOT_ECONOMIC' | 'READY' | 'IN_PROGRESS' | 'TRANSFERRED'

export interface AddressQuery {
  networkId?: string
  recoveryStatus?: RecoveryStatus
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

// ─── Scans (Phase 5) ───

export type ScanStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export interface PublicScan {
  id: string
  network: { id: string; name: string; displayName: string; nativeSymbol: string | null }
  status: ScanStatus
  trigger: 'MANUAL' | 'SCHEDULED'
  thresholdDays: number
  minimumBalance: string | null
  maximumBalance: string | null
  totalAddresses: number
  processedAddresses: number
  totalInactive: number
  totalFailed: number
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export type ResultFilter = 'all' | 'inactive' | 'criteria' | 'review' | 'failed'

export interface ScanResultItem {
  addressId: string
  address: string
  label: string | null
  activityStatus: 'UNKNOWN' | 'ACTIVE' | 'INACTIVE'
  balanceStatus: string
  inactiveDays: number | null
  lastActivityAt: string | null
  lastOutgoingAt: string | null
  incomingTxCount: number | null
  outgoingTxCount: number | null
  nonce: number | null
  reviewFlag: boolean
  errorCode: string | null
  nativeBalance: string | null
  matchesCriteria: boolean
}

export interface AddressBalance {
  assetId: string
  symbol: string
  name: string
  isNative: boolean
  decimals: number
  quantity: string
  formatted: string
  updatedAt: string
  fiatCurrency: string
  fiatValue: string | null
  price: string | null
  priceSource: string | null
  pricedAt: string | null
  simulated: boolean
}

export interface AddressScanHistory {
  scanId: string
  scannedAt: string
  thresholdDays: number
  activityStatus: string
  balanceStatus: string
  inactiveDays: number | null
  lastIncomingAt: string | null
  lastOutgoingAt: string | null
  incomingTxCount: number | null
  outgoingTxCount: number | null
  nonce: number | null
  reviewFlag: boolean
  errorCode: string | null
}

export const scansApi = {
  list: (page = 1) =>
    apiFetch<{ items: PublicScan[]; total: number; page: number; pageSize: number }>(
      `/api/scans?page=${page}&pageSize=20`,
    ),
  create: (input: {
    networkId: string
    thresholdDays?: number
    minimumBalance?: string | null
    maximumBalance?: string | null
  }) =>
    apiFetch<{ scan: PublicScan }>('/api/scans', { method: 'POST', body: input }).then(
      (r) => r.scan,
    ),
  get: (id: string) => apiFetch<{ scan: PublicScan }>(`/api/scans/${id}`).then((r) => r.scan),
  results: (id: string, filter: ResultFilter, page: number) =>
    apiFetch<{ items: ScanResultItem[]; total: number; page: number; pageSize: number }>(
      `/api/scans/${id}/results?filter=${filter}&page=${page}&pageSize=50`,
    ),
  addressBalances: (addressId: string) =>
    apiFetch<{ balances: AddressBalance[] }>(`/api/addresses/${addressId}/balances`).then(
      (r) => r.balances,
    ),
  addressActivity: (addressId: string) =>
    apiFetch<{ history: AddressScanHistory[] }>(`/api/addresses/${addressId}/activity`).then(
      (r) => r.history,
    ),
}

export const isScanRunning = (scan: Pick<PublicScan, 'status'>) =>
  scan.status === 'QUEUED' || scan.status === 'RUNNING'

// ─── Valuation, dashboard, reports (Phase 6) ───

export interface ValueBlock {
  value: string
  simulatedValue: string
  oldestPriceAt: string | null
  priceSource: string | null
}

export interface DashboardSummary {
  fiatCurrency: string
  networkId: string | null
  addresses: {
    total: number
    active: number
    inactive: number
    unscanned: number
    withBalance: number
    verified: number
    needsReview: number
  }
  inactiveValue: ValueBlock
  totalValue: ValueBlock
  transactions: { pending: number; completed: number }
  networks: Array<{
    id: string
    name: string
    displayName: string
    isTestnet: boolean
    lastScan: {
      id: string
      status: ScanStatus
      trigger: 'MANUAL' | 'SCHEDULED'
      createdAt: string
      completedAt: string | null
    } | null
  }>
  recentScans: Array<{
    id: string
    network: string
    status: ScanStatus
    trigger: 'MANUAL' | 'SCHEDULED'
    totalAddresses: number
    totalInactive: number
    createdAt: string
  }>
  schedule: {
    scansEnabled: boolean
    scanPattern: string | null
    timezone: string
    nextScanAt: string | null
    priceIntervalMinutes: number
  } | null
}

export const dashboardApi = {
  summary: (networkId?: string) =>
    apiFetch<DashboardSummary>(`/api/dashboard${networkId ? `?networkId=${networkId}` : ''}`),
}

export const pricesApi = {
  refresh: () =>
    apiFetch<{ priced: number; missing: string[]; revaluedBalances: number }>(
      '/api/prices/refresh',
      {
        method: 'POST',
        body: {},
      },
    ),
  setPriceId: (networkId: string, assetId: string, priceId: string | null) =>
    apiFetch<{ asset: { id: string; symbol: string; priceId: string | null } }>(
      `/api/networks/${networkId}/assets/${assetId}`,
      { method: 'PATCH', body: { priceId } },
    ),
}

/** Download links: the browser sends the session cookie with same-origin GETs. */
export const reportUrls = {
  inventory: '/api/reports/addresses.csv?type=inventory',
  inactivity: '/api/reports/addresses.csv?type=inactivity',
  eligibility: '/api/reports/eligibility.csv',
}

/** Formats a fiat amount string for display without ever parsing it into a float. */
export function formatFiat(value: string | null | undefined, currency: string): string {
  if (value === null || value === undefined || value === '') return '—'
  const [whole = '0', fraction = ''] = value.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, currency === 'IDR' ? '.' : ',')
  const sep = currency === 'IDR' ? ',' : '.'
  const trimmed = fraction.replace(/0+$/, '')
  const shown = trimmed.length <= 2 ? fraction.slice(0, 2).padEnd(2, '0') : trimmed
  return `${currency === 'IDR' ? 'Rp' : '$'}${grouped}${sep}${shown}`
}

// ─── Key vault (Phase 7, SUPER_ADMIN) ───

export interface VaultStatus {
  initialized: boolean
  unlocked: boolean
  unlockedBy: string | null
  expiresAt: string | null
  unlockTtlMinutes: number
}

export interface VaultKey {
  chainType: string
  address: string
  checksumAddress: string
  keyType: 'PRIVATE_KEY' | 'DERIVED_FROM_MNEMONIC'
  derivationPath: string | null
  importedBy: string
  createdAt: string
  lastUsedAt: string | null
  inventory: Array<{
    addressId: string
    label: string | null
    archived: boolean
    network: { id: string; displayName: string }
  }>
}

export const vaultApi = {
  status: () => apiFetch<VaultStatus>('/api/vault/status'),
  keys: () => apiFetch<{ keys: VaultKey[] }>('/api/vault/keys').then((r) => r.keys),
  init: (passphrase: string, recoveryPassphrase: string) =>
    apiFetch<VaultStatus>('/api/vault/init', {
      method: 'POST',
      body: { passphrase, recoveryPassphrase },
    }),
  unlock: (passphrase: string) =>
    apiFetch<VaultStatus>('/api/vault/unlock', { method: 'POST', body: { passphrase } }),
  lock: () => apiFetch<VaultStatus>('/api/vault/lock', { method: 'POST', body: {} }),
  changePassphrase: (currentPassphrase: string, newPassphrase: string) =>
    apiFetch<VaultStatus>('/api/vault/passphrase', {
      method: 'POST',
      body: { currentPassphrase, newPassphrase },
    }),
  recover: (recoveryPassphrase: string, newPassphrase: string) =>
    apiFetch<VaultStatus>('/api/vault/recover', {
      method: 'POST',
      body: { recoveryPassphrase, newPassphrase },
    }),
  importKey: (input: {
    addressId: string
    secretType: 'PRIVATE_KEY' | 'MNEMONIC'
    secret: string
    derivationPath: string | null
  }) => apiFetch<{ key: VaultKey }>('/api/vault/keys', { method: 'POST', body: input }),
  reveal: (addressId: string, passphrase: string, code: string) =>
    apiFetch<{ privateKey: string }>('/api/vault/keys/reveal', {
      method: 'POST',
      body: { addressId, passphrase, code },
    }),
}

export const reauthApi = {
  /** Re-confirms the session (password + current authenticator code). */
  reauth: (password: string, code: string) =>
    apiFetch<void>('/api/auth/reauth', { method: 'POST', body: { password, code } }),
}

// ─── Ownership verification (Phase 7c) ───

export type AuthorizationType = 'SELF' | 'MANDATE' | 'CONTRACT'
export type AuthorizationStatus = 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'

export interface PublicAuthorization {
  id: string
  address: { id: string; address: string; label: string | null; network: string }
  type: AuthorizationType
  reference: string
  documentName: string | null
  documentSha256: string | null
  status: AuthorizationStatus
  verifiedAt: string | null
  expiresAt: string | null
  createdAt: string
  challenges: Array<{
    id: string
    method: 'VAULT' | 'WALLET' | 'MANUAL' | null
    result: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'
    issuedAt: string
    expiresAt: string
    usedAt: string | null
  }>
}

export interface OwnershipChallenge {
  id: string
  address: string
  message: string
  expiresAt: string
}

export interface VerificationResult {
  result: 'VERIFIED'
  authorization: PublicAuthorization
}

export const ownershipApi = {
  list: (status?: AuthorizationStatus) =>
    apiFetch<{ authorizations: PublicAuthorization[] }>(
      `/api/authorizations${status ? `?status=${status}` : ''}`,
    ).then((r) => r.authorizations),
  forAddress: (addressId: string) =>
    apiFetch<{ authorizations: PublicAuthorization[] }>(
      `/api/addresses/${addressId}/authorizations`,
    ).then((r) => r.authorizations),
  create: (
    addressId: string,
    input: {
      type: AuthorizationType
      reference: string
      documentSha256: string | null
      documentName: string | null
      expiresAt: string | null
    },
  ) =>
    apiFetch<{ authorization: PublicAuthorization }>(`/api/addresses/${addressId}/authorizations`, {
      method: 'POST',
      body: input,
    }).then((r) => r.authorization),
  challenge: (authorizationId: string) =>
    apiFetch<{ challenge: OwnershipChallenge }>(
      `/api/authorizations/${authorizationId}/challenges`,
      { method: 'POST', body: {} },
    ).then((r) => r.challenge),
  submitSignature: (challengeId: string, signature: string, method: 'WALLET' | 'MANUAL') =>
    apiFetch<VerificationResult>(`/api/challenges/${challengeId}/signature`, {
      method: 'POST',
      body: { signature, method },
    }),
  vaultSign: (challengeId: string) =>
    apiFetch<VerificationResult>(`/api/challenges/${challengeId}/vault-signature`, {
      method: 'POST',
      body: {},
    }),
}

// ─── Destination whitelist (Phase 8a) ───

export type DestinationStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'DISABLED'
type Person = { id: string; name: string } | null

export interface PublicDestination {
  id: string
  network: { id: string; name: string; displayName: string; isTestnet: boolean }
  address: string
  label: string
  status: DestinationStatus
  statusReason: string | null
  controlVerifiedAt: string | null
  controlVerifiedBy: Person
  createdBy: Person
  createdAt: string
  approvals: Array<{
    id: string
    requestedBy: Person
    decidedBy: Person
    decision: 'APPROVED' | 'REJECTED' | null
    reason: string | null
    decidedAt: string | null
    createdAt: string
  }>
  challenges: Array<{
    id: string
    method: 'WALLET' | 'MANUAL' | 'VAULT' | null
    result: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'
    issuedAt: string
    expiresAt: string
    usedAt: string | null
  }>
}

const destinationAction = (id: string, action: string, body: object = {}) =>
  apiFetch<{ destination: PublicDestination }>(`/api/destinations/${id}/${action}`, {
    method: 'POST',
    body,
  }).then((r) => r.destination)

export const destinationsApi = {
  list: (status?: DestinationStatus) =>
    apiFetch<{ destinations: PublicDestination[] }>(
      `/api/destinations${status ? `?status=${status}` : ''}`,
    ).then((r) => r.destinations),
  create: (input: { networkId: string; address: string; label: string }) =>
    apiFetch<{ destination: PublicDestination }>('/api/destinations', {
      method: 'POST',
      body: input,
    }).then((r) => r.destination),
  challenge: (id: string) =>
    apiFetch<{ challenge: OwnershipChallenge }>(`/api/destinations/${id}/challenges`, {
      method: 'POST',
      body: {},
    }).then((r) => r.challenge),
  submitSignature: (challengeId: string, signature: string, method: 'WALLET' | 'MANUAL') =>
    apiFetch<{ result: 'VERIFIED'; destination: PublicDestination }>(
      `/api/destination-challenges/${challengeId}/signature`,
      { method: 'POST', body: { signature, method } },
    ),
  approve: (id: string, note: string | null) => destinationAction(id, 'approve', { note }),
  reject: (id: string, reason: string) => destinationAction(id, 'reject', { reason }),
  disable: (id: string, reason: string) => destinationAction(id, 'disable', { reason }),
  resubmit: (id: string) => destinationAction(id, 'resubmit'),
}

// ─── Recovery eligibility (Phase 8b) ───

export interface AssetEligibility {
  assetId: string
  symbol: string
  isNative: boolean
  status: 'READY' | 'NOT_ELIGIBLE' | 'NOT_ECONOMIC'
  reason: string | null
  /** Base units and the exact decimal form — never parsed into a float. */
  quantity: string
  formatted: string
  feeEstimate: string | null
  valueFiat: string | null
  feeFiat: string | null
  netFiat: string | null
  fiatCurrency: string
  simulated: boolean
  computedAt: string
}

export interface EligibilitySummary {
  networkId: string
  evaluated: number
  ready: number
  notEligible: number
  notEconomic: number
  feeError: string | null
  computedAt: string
}

export interface EligibilityConfig {
  minNetValue: string
  feeMarginPercent: number
  balanceMaxAgeHours: number
  fiatCurrency: string
}

export const eligibilityApi = {
  config: () => apiFetch<EligibilityConfig>('/api/eligibility/config'),
  forAddress: (addressId: string) =>
    apiFetch<{ assets: AssetEligibility[] }>(`/api/addresses/${addressId}/eligibility`).then(
      (r) => r.assets,
    ),
  evaluate: (networkId: string) =>
    apiFetch<EligibilitySummary>('/api/eligibility/evaluate', {
      method: 'POST',
      body: { networkId },
    }),
}

// ─── Transactions: preview & approval (Phase 9) ───

export type TransactionStatus =
  | 'CREATED'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'SIGNED'
  | 'BROADCASTED'
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'CANCELLED'

export interface PublicTransaction {
  id: string
  status: TransactionStatus
  statusReason: string | null
  network: {
    id: string
    name: string
    displayName: string
    isTestnet: boolean
    chainId: number | null
  }
  source: { addressId: string; address: string; label: string | null }
  destination: { id: string; address: string; label: string }
  asset: {
    id: string
    symbol: string
    decimals: number
    isNative: boolean
    contractAddress: string | null
  }
  amount: string
  amountFormatted: string
  sweep: boolean
  nonce: number | null
  gasLimit: string | null
  maxFeePerGas: string | null
  maxPriorityFeePerGas: string | null
  networkFee: string | null
  networkFeeFormatted: string | null
  nativeSymbol: string
  estimatedValue: string | null
  valueSimulated: boolean
  fiatCurrency: string
  unsignedHash: string | null
  unsignedPayload: Record<string, string | number> | null
  createdBy: { id: string; name: string } | null
  createdAt: string
  approvals: Array<{
    id: string
    requestedBy: { id: string; name: string } | null
    decidedBy: { id: string; name: string } | null
    decision: 'APPROVED' | 'REJECTED' | null
    reason: string | null
    decidedAt: string | null
    expiresAt: string | null
  }>
}

const transactionAction = (id: string, action: string, reason: string) =>
  apiFetch<{ transaction: PublicTransaction }>(`/api/transactions/${id}/${action}`, {
    method: 'POST',
    body: { reason },
  }).then((r) => r.transaction)

export const transactionsApi = {
  list: (filter: { status?: TransactionStatus; addressId?: string } = {}) => {
    const params = new URLSearchParams()
    if (filter.status) params.set('status', filter.status)
    if (filter.addressId) params.set('addressId', filter.addressId)
    const qs = params.toString()
    return apiFetch<{ transactions: PublicTransaction[] }>(
      `/api/transactions${qs ? `?${qs}` : ''}`,
    ).then((r) => r.transactions)
  },
  get: (id: string) =>
    apiFetch<{ transaction: PublicTransaction }>(`/api/transactions/${id}`).then(
      (r) => r.transaction,
    ),
  preview: (input: {
    addressId: string
    assetId: string
    destinationId: string
    amount: string | null
  }) =>
    apiFetch<{ transaction: PublicTransaction }>('/api/transactions/preview', {
      method: 'POST',
      body: input,
    }).then((r) => r.transaction),
  approve: (id: string, reason: string) => transactionAction(id, 'approve', reason),
  reject: (id: string, reason: string) => transactionAction(id, 'reject', reason),
  cancel: (id: string, reason: string) => transactionAction(id, 'cancel', reason),
}
