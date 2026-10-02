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

  async function wrap(masterKey: Buffer, passphrase: string, aad: string) {
    const salt = randomBytes(SALT_BYTES)
    const kek = await deriveKek(passphrase, salt, deps.kdf)
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
    type: 'UNLOCK_FAILED' | 'RECOVERY_FAILED',
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
    async init(input: { passphrase: string; recoveryPassphrase: string; actor: string }) {
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
        const main = await wrap(masterKey, input.passphrase, AAD_MAIN)
        const recovery = await wrap(masterKey, input.recoveryPassphrase, AAD_RECOVERY)
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
    },

    async unlock(input: { passphrase: string; actor: string }) {
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
    },

    async lock(input: { actor: string }) {
      if (state.clear()) {
        await repo.event('LOCK', { actor: input.actor })
        logger.info('VAULT_LOCKED')
      }
      return service.status()
    },

    /** Re-wraps the master key under a new main passphrase. Keys themselves are untouched. */
    async changePassphrase(input: {
      currentPassphrase: string
      newPassphrase: string
      actor: string
    }) {
      const config = await requireConfig()
      assertPolicy(input.newPassphrase, 'newPassphrase')
      assertNotThrottled()
      const masterKey = await unwrap(config, input.currentPassphrase, 'main')
      if (!masterKey) return failed('UNLOCK_FAILED', input.actor, 'Wrong current passphrase')
      try {
        const main = await wrap(masterKey, input.newPassphrase, AAD_MAIN)
        await repo.updateConfig({ mainSalt: main.salt, mainWrappedKey: main.wrapped })
      } finally {
        wipe(masterKey)
      }
      failures = []
      await repo.event('PASSPHRASE_CHANGED', { actor: input.actor })
      return service.status()
    },

    /** Lost main passphrase: open with the offline recovery passphrase and set a new main one. */
    async recover(input: { recoveryPassphrase: string; newPassphrase: string; actor: string }) {
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
        const main = await wrap(masterKey, input.newPassphrase, AAD_MAIN)
        await repo.updateConfig({ mainSalt: main.salt, mainWrappedKey: main.wrapped })
      } finally {
        wipe(masterKey)
      }
      failures = []
      state.clear()
      await repo.event('RECOVERED', { actor: input.actor })
      return service.status()
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
