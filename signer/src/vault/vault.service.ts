import { randomBytes } from 'node:crypto'
import { AppError, type Logger } from '@da/shared'
import { KEY_BYTES, open, pack, seal, unpack, wipe } from '../crypto/aead'
import {
  deriveKek,
  KDF_ALGORITHM,
  SALT_BYTES,
  vaultPassphraseViolation,
  type KdfParams,
} from '../crypto/kdf'
import type { VaultConfig } from '../generated/prisma/client'
import { createUnlockState } from './unlock-state'
import type { VaultRepository } from './vault.repository'

/** AAD labels: a wrapped key only opens for the purpose it was sealed for. */
const AAD_MAIN = 'da-vault/master-key/v1/main'
const AAD_RECOVERY = 'da-vault/master-key/v1/recovery'

/** Failed passphrase attempts (unlock, change, recover) before a cool-down. */
const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 15 * 60_000

export interface VaultServiceDeps {
  repo: VaultRepository
  logger: Logger
  unlockTtlMs: number
  /** Argon2id cost for NEW wrappings; existing ones keep the parameters they were made with. */
  kdf: KdfParams
  now?: () => number
}

function paramsOf(config: VaultConfig): KdfParams {
  return {
    memoryCost: config.kdfMemoryCost,
    timeCost: config.kdfTimeCost,
    parallelism: config.kdfParallelism,
  }
}

export function createVaultService(deps: VaultServiceDeps) {
  const { repo, logger } = deps
  const now = deps.now ?? Date.now
  const state = createUnlockState({
    ttlMs: deps.unlockTtlMs,
    now,
    onExpire: (actor) => {
      logger.info('VAULT_AUTO_LOCKED')
      void repo
        .event('AUTO_LOCK', { actor })
        .catch((err: unknown) => logger.error({ err }, 'VAULT_EVENT_FAILED'))
    },
  })

  let failures: number[] = []
  function assertNotThrottled(): void {
    failures = failures.filter((t) => now() - t < FAILURE_WINDOW_MS)
    if (failures.length >= MAX_FAILURES) {
      throw new AppError('RATE_LIMITED', 'Too many wrong passphrases. Try again later.')
    }
  }

  async function requireConfig(): Promise<VaultConfig> {
    const config = await repo.getConfig()
    if (!config) throw new AppError('VAULT_NOT_INITIALIZED', 'The vault has not been initialised')
    return config
  }

  function assertPolicy(passphrase: string, field: string): void {
    const violation = vaultPassphraseViolation(passphrase)
    if (violation) throw new AppError('VALIDATION_ERROR', `${field}: ${violation}`)
  }

  /**
   * Passphrase operations run strictly one at a time: the failure throttle then sees every
   * attempt in order (parallel requests cannot all slip past it), and at most one Argon2id
   * (64 MiB) runs at a time, so a burst of requests cannot exhaust the signer's memory.
   */
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn, fn)
    queue = result.catch(() => undefined)
    return result
  }

  /**
   * Wraps with the given KDF parameters. Re-wrapping (change passphrase, recover) must use the
   * parameters STORED in vault_config, which unwrap() reads; otherwise a future change of the
   * defaults would make the new main wrapping unreadable.
   */
  async function wrap(masterKey: Buffer, passphrase: string, aad: string, params: KdfParams) {
    const salt = randomBytes(SALT_BYTES)
    const kek = await deriveKek(passphrase, salt, params)
    try {
      // Uint8Array copies: the type Prisma expects for Bytes columns.
      return {
        salt: new Uint8Array(salt),
        wrapped: new Uint8Array(pack(seal(kek, masterKey, aad))),
      }
    } finally {
      wipe(kek)
    }
  }

  /** Unwraps the master key with a passphrase. Returns null (never throws) on a wrong passphrase. */
  async function unwrap(
    config: VaultConfig,
    passphrase: string,
    which: 'main' | 'recovery',
  ): Promise<Buffer | null> {
    const salt = Buffer.from(which === 'main' ? config.mainSalt : config.recoverySalt)
    const packed = Buffer.from(which === 'main' ? config.mainWrappedKey : config.recoveryWrappedKey)
    const kek = await deriveKek(passphrase, salt, paramsOf(config))
    try {
      return open(kek, unpack(packed), which === 'main' ? AAD_MAIN : AAD_RECOVERY)
    } catch {
      return null
    } finally {
      wipe(kek)
    }
  }

  async function failed(
    type: 'UNLOCK_FAILED' | 'RECOVERY_FAILED' | 'REVEAL_FAILED',
    actor: string,
    message: string,
  ): Promise<never> {
    failures.push(now())
    await repo.event(type, { actor })
    throw new AppError('PASSPHRASE_INVALID', message)
  }

  const service = {
    async status() {
      const config = await repo.getConfig()
      return {
        initialized: config !== null,
        ...state.status(),
        unlockTtlMinutes: Math.round(deps.unlockTtlMs / 60_000),
      }
    },

    /**
     * One-time setup: a random master key, wrapped twice (main passphrase + offline recovery
     * passphrase). The vault stays LOCKED afterwards. Neither passphrase is stored.
     */
    init(input: { passphrase: string; recoveryPassphrase: string; actor: string }) {
      return serial(async () => {
        if (await repo.getConfig()) {
          throw new AppError('VAULT_ALREADY_INITIALIZED', 'The vault is already initialised')
        }
        assertPolicy(input.passphrase, 'passphrase')
        assertPolicy(input.recoveryPassphrase, 'recoveryPassphrase')
        if (input.passphrase === input.recoveryPassphrase) {
          throw new AppError(
            'VALIDATION_ERROR',
            'The recovery passphrase must differ from the main passphrase',
          )
        }

        const masterKey = randomBytes(KEY_BYTES)
        try {
          const main = await wrap(masterKey, input.passphrase, AAD_MAIN, deps.kdf)
          const recovery = await wrap(masterKey, input.recoveryPassphrase, AAD_RECOVERY, deps.kdf)
          try {
            await repo.createConfig({
              kdfAlgorithm: KDF_ALGORITHM,
              kdfMemoryCost: deps.kdf.memoryCost,
              kdfTimeCost: deps.kdf.timeCost,
              kdfParallelism: deps.kdf.parallelism,
              mainSalt: main.salt,
              mainWrappedKey: main.wrapped,
              recoverySalt: recovery.salt,
              recoveryWrappedKey: recovery.wrapped,
              initializedBy: input.actor,
            })
          } catch {
            // Lost a race with a concurrent init (singleton row already exists).
            throw new AppError('VAULT_ALREADY_INITIALIZED', 'The vault is already initialised')
          }
        } finally {
          wipe(masterKey)
        }
        await repo.event('INIT', { actor: input.actor })
        logger.info('VAULT_INITIALIZED')
        return service.status()
      })
    },

    unlock(input: { passphrase: string; actor: string }) {
      return serial(async () => {
        const config = await requireConfig()
        assertNotThrottled()
        const masterKey = await unwrap(config, input.passphrase, 'main')
        if (!masterKey) return failed('UNLOCK_FAILED', input.actor, 'Wrong passphrase')
        failures = []
        const expiresAt = state.set(masterKey, input.actor) // copies, then wipes masterKey
        await repo.event('UNLOCK', {
          actor: input.actor,
          metadata: { expiresAt: new Date(expiresAt).toISOString() },
        })
        logger.info('VAULT_UNLOCKED')
        return service.status()
      })
    },

    async lock(input: { actor: string }) {
      if (state.clear()) {
        await repo.event('LOCK', { actor: input.actor })
        logger.info('VAULT_LOCKED')
      }
      return service.status()
    },

    /** Re-wraps the master key under a new main passphrase. Keys themselves are untouched. */
    changePassphrase(input: { currentPassphrase: string; newPassphrase: string; actor: string }) {
      return serial(async () => {
        const config = await requireConfig()
        assertPolicy(input.newPassphrase, 'newPassphrase')
        assertNotThrottled()
        const masterKey = await unwrap(config, input.currentPassphrase, 'main')
        if (!masterKey) return failed('UNLOCK_FAILED', input.actor, 'Wrong current passphrase')
        try {
          const main = await wrap(masterKey, input.newPassphrase, AAD_MAIN, paramsOf(config))
          await repo.updateConfig({ mainSalt: main.salt, mainWrappedKey: main.wrapped })
        } finally {
          wipe(masterKey)
        }
        failures = []
        await repo.event('PASSPHRASE_CHANGED', { actor: input.actor })
        return service.status()
      })
    },

    /** Lost main passphrase: open with the offline recovery passphrase and set a new main one. */
    recover(input: { recoveryPassphrase: string; newPassphrase: string; actor: string }) {
      return serial(async () => {
        const config = await requireConfig()
        assertPolicy(input.newPassphrase, 'newPassphrase')
        if (input.newPassphrase === input.recoveryPassphrase) {
          throw new AppError(
            'VALIDATION_ERROR',
            'The new passphrase must differ from the recovery passphrase',
          )
        }
        assertNotThrottled()
        const masterKey = await unwrap(config, input.recoveryPassphrase, 'recovery')
        if (!masterKey) return failed('RECOVERY_FAILED', input.actor, 'Wrong recovery passphrase')
        try {
          const main = await wrap(masterKey, input.newPassphrase, AAD_MAIN, paramsOf(config))
          await repo.updateConfig({ mainSalt: main.salt, mainWrappedKey: main.wrapped })
        } finally {
          wipe(masterKey)
        }
        failures = []
        state.clear()
        await repo.event('RECOVERED', { actor: input.actor })
        return service.status()
      })
    },

    /**
     * Opens the master key from the passphrase itself, independent of the unlock state —
     * for break-glass actions that must re-prove knowledge of the passphrase (reveal, ADR-009).
     * Wrong passphrases count towards the same throttle as unlock.
     */
    withPassphrase<T>(
      passphrase: string,
      actor: string,
      fn: (masterKey: Buffer) => Promise<T> | T,
    ): Promise<T> {
      return serial(async () => {
        const config = await requireConfig()
        assertNotThrottled()
        const masterKey = await unwrap(config, passphrase, 'main')
        if (!masterKey) return failed('REVEAL_FAILED', actor, 'Wrong passphrase')
        failures = []
        try {
          return await fn(masterKey)
        } finally {
          wipe(masterKey)
        }
      })
    },

    /** For key operations (Phase 7b+): runs `fn` with the in-memory master key. */
    withMasterKey<T>(fn: (masterKey: Buffer) => Promise<T> | T): Promise<T> {
      return state.use(fn)
    },

    /** Wipes the master key (process shutdown). */
    shutdown(): void {
      state.clear()
    },
  }
  return service
}

export type VaultService = ReturnType<typeof createVaultService>
