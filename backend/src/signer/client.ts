import { AppError, ERROR_HTTP_STATUS, signRequest, type ErrorCode } from '@da/shared'

/**
 * The backend's ONLY way to touch keys: HMAC-signed calls to the internal signer (ADR-008).
 * The backend never sees the master key; plaintext keys pass through only on break-glass
 * reveal (ADR-009) and are never stored or logged here.
 */
export interface VaultStatus {
  initialized: boolean
  unlocked: boolean
  unlockedBy: string | null
  expiresAt: string | null
  unlockTtlMinutes: number
}

export interface SignerKey {
  chainType: string
  address: string
  keyType: 'PRIVATE_KEY' | 'DERIVED_FROM_MNEMONIC'
  derivationPath: string | null
  importedBy: string
  createdAt: string
  lastUsedAt: string | null
}

export interface SignerClient {
  status(): Promise<VaultStatus>
  init(input: {
    actor: string
    passphrase: string
    recoveryPassphrase: string
  }): Promise<VaultStatus>
  unlock(input: { actor: string; passphrase: string }): Promise<VaultStatus>
  lock(input: { actor: string }): Promise<VaultStatus>
  changePassphrase(input: {
    actor: string
    currentPassphrase: string
    newPassphrase: string
  }): Promise<VaultStatus>
  recover(input: {
    actor: string
    recoveryPassphrase: string
    newPassphrase: string
  }): Promise<VaultStatus>
  listKeys(): Promise<SignerKey[]>
  importKey(input: {
    actor: string
    expectedAddress: string
    secretType: 'PRIVATE_KEY' | 'MNEMONIC'
    secret: string
    derivationPath?: string | null
  }): Promise<SignerKey>
  revealKey(input: {
    actor: string
    address: string
    passphrase: string
  }): Promise<{ privateKey: string }>
}

/** Argon2id with 64 MiB runs per call, so allow generous time. */
const TIMEOUT_MS = 30_000

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_HTTP_STATUS
}

export function createHttpSignerClient(options: {
  baseUrl: string
  secret: string | undefined
  fetch?: typeof fetch
  now?: () => number
}): SignerClient {
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const base = options.baseUrl.replace(/\/$/, '')

  async function call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    if (!options.secret) {
      throw new AppError('SIGNER_UNAVAILABLE', 'The signer is not configured (SIGNER_HMAC_SECRET)')
    }
    const payload = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = signRequest(options.secret, {
      method,
      path,
      body: payload,
      timestamp: now(),
    })
    if (body !== undefined) headers['content-type'] = 'application/json'

    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new AppError('SIGNER_UNAVAILABLE', 'The signer service is not reachable')
    }

    const json = (await res.json().catch(() => null)) as
      (T & { error?: { code?: unknown; message?: unknown } }) | null
    if (!res.ok) {
      const code = json?.error?.code
      const message =
        typeof json?.error?.message === 'string' ? json.error.message : 'Signer request failed'
      // A 401 from the signer means OUR signature was rejected (misconfiguration), not the user.
      if (res.status === 401 && code === 'UNAUTHORIZED') {
        throw new AppError(
          'SIGNER_UNAVAILABLE',
          'The signer rejected the backend (check SIGNER_HMAC_SECRET)',
        )
      }
      throw new AppError(isErrorCode(code) ? code : 'SIGNER_UNAVAILABLE', message)
    }
    return json as T
  }

  return {
    status: () => call('GET', '/vault/status'),
    init: (input) => call('POST', '/vault/init', input),
    unlock: (input) => call('POST', '/vault/unlock', input),
    lock: (input) => call('POST', '/vault/lock', input),
    changePassphrase: (input) => call('POST', '/vault/passphrase', input),
    recover: (input) => call('POST', '/vault/recover', input),
    listKeys: async () => (await call<{ keys: SignerKey[] }>('GET', '/vault/keys')).keys,
    importKey: async (input) =>
      (await call<{ key: SignerKey }>('POST', '/vault/keys/import', input)).key,
    revealKey: (input) => call('POST', '/vault/keys/reveal', input),
  }
}
