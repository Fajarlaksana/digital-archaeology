import { AppError } from '@da/shared'
import { wipe } from '../crypto/aead'

/**
 * Holds the master key in memory while the vault is unlocked — the only place it ever exists
 * in plaintext (CLAUDE.md rule 4). Lock, expiry and process exit all wipe it.
 */
export function createUnlockState(options: {
  ttlMs: number
  now: () => number
  /** Called once when the key expires (timer or lazy check), for the event log. */
  onExpire: (actor: string | null) => void
}) {
  let key: Buffer | null = null
  let expiresAt = 0
  let unlockedBy: string | null = null
  let timer: NodeJS.Timeout | null = null

  function clear(): boolean {
    const wasUnlocked = key !== null
    wipe(key)
    key = null
    unlockedBy = null
    expiresAt = 0
    if (timer) clearTimeout(timer)
    timer = null
    return wasUnlocked
  }

  function expireIfDue(): void {
    if (key && options.now() >= expiresAt) {
      const actor = unlockedBy
      clear()
      options.onExpire(actor)
    }
  }

  return {
    /** Takes ownership of `masterKey`: the caller's buffer is copied and then wiped. */
    set(masterKey: Buffer, actor: string): number {
      clear()
      key = Buffer.from(masterKey)
      wipe(masterKey)
      unlockedBy = actor
      expiresAt = options.now() + options.ttlMs
      timer = setTimeout(expireIfDue, options.ttlMs + 50)
      timer.unref()
      return expiresAt
    },

    /**
     * Runs `fn` with the master key. The key must not be retained beyond the call.
     * Throws VAULT_LOCKED when locked or expired.
     */
    async use<T>(fn: (masterKey: Buffer) => Promise<T> | T): Promise<T> {
      expireIfDue()
      if (!key) throw new AppError('VAULT_LOCKED', 'The vault is locked')
      return fn(key)
    },

    clear,

    status() {
      expireIfDue()
      return {
        unlocked: key !== null,
        unlockedBy,
        expiresAt: key ? new Date(expiresAt).toISOString() : null,
      }
    },
  }
}

export type UnlockState = ReturnType<typeof createUnlockState>
