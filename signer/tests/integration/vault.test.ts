import { randomBytes, randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { createLogger, signRequest } from '@da/shared'
import { buildSignerApp } from '../../src/app'
import { open, unpack } from '../../src/crypto/aead'
import { deriveKek } from '../../src/crypto/kdf'
import { createKeyService } from '../../src/keys/key.service'
import { createTransactionSigner } from '../../src/transactions/sign-transaction'
import {
  createVaultDatabase,
  createVaultRepository,
  type VaultDatabase,
} from '../../src/vault/vault.repository'
import { createVaultService, type VaultService } from '../../src/vault/vault.service'

const testDatabaseUrl = inject('testDatabaseUrl')
const FAST_KDF = { memoryCost: 4096, timeCost: 1, parallelism: 1 }
const SECRET = 'h'.repeat(48)
const PASSPHRASE = 'marble orbit cactus lantern'
const RECOVERY = 'violet harbor tundra pencil quartz'
const ACTOR = randomUUID()

/**
 * The vault is a singleton row, so every test starts from an empty vault_config.
 * Tests in this file run sequentially (single file, no concurrency).
 */
describe.skipIf(!testDatabaseUrl)('key vault (signer)', () => {
  let db: VaultDatabase
  let clock: number
  let logLines: string[]
  let vault: VaultService

  beforeAll(() => {
    db = createVaultDatabase(testDatabaseUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })
  afterEach(() => {
    vault?.shutdown()
  })

  async function freshVault(ttlMs = 10 * 60_000) {
    await db.vaultKey.deleteMany({})
    await db.vaultConfig.deleteMany({})
    clock = Date.now()
    logLines = []
    const logger = createLogger({
      name: 'signer-test',
      level: 'trace',
      destination: new Writable({
        write(chunk: Buffer, _e, cb) {
          logLines.push(chunk.toString())
          cb()
        },
      }),
    })
    vault = createVaultService({
      repo: createVaultRepository(db),
      logger,
      unlockTtlMs: ttlMs,
      kdf: FAST_KDF,
      now: () => clock,
    })
    return { vault, logger }
  }

  async function initialised() {
    const ctx = await freshVault()
    await vault.init({ passphrase: PASSPHRASE, recoveryPassphrase: RECOVERY, actor: ACTOR })
    return ctx
  }

  describe('initialisation', () => {
    it('stores only wrapped material and stays locked', async () => {
      await freshVault()
      const status = await vault.init({
        passphrase: PASSPHRASE,
        recoveryPassphrase: RECOVERY,
        actor: ACTOR,
      })
      expect(status).toMatchObject({ initialized: true, unlocked: false })

      const config = await db.vaultConfig.findUniqueOrThrow({ where: { id: 1 } })
      expect(config).toMatchObject({
        kdfAlgorithm: 'argon2id',
        kdfMemoryCost: 4096,
        initializedBy: ACTOR,
      })
      const everything = JSON.stringify(config, (_k, v) =>
        v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v,
      )
      expect(everything).not.toContain(Buffer.from(PASSPHRASE).toString('hex'))
      expect(everything).not.toContain(PASSPHRASE)
    })

    it('cannot be initialised twice', async () => {
      await initialised()
      await expect(
        vault.init({ passphrase: PASSPHRASE, recoveryPassphrase: RECOVERY, actor: ACTOR }),
      ).rejects.toMatchObject({ code: 'VAULT_ALREADY_INITIALIZED' })
    })

    it('enforces the passphrase policy and distinct recovery passphrase', async () => {
      await freshVault()
      await expect(
        vault.init({ passphrase: 'short', recoveryPassphrase: RECOVERY, actor: ACTOR }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      })
      await expect(
        vault.init({ passphrase: PASSPHRASE, recoveryPassphrase: PASSPHRASE, actor: ACTOR }),
      ).rejects.toThrow(/must differ/)
    })
  })

  describe('a stolen database alone is useless', () => {
    it('the master key cannot be unwrapped without a passphrase', async () => {
      await initialised()
      const config = await db.vaultConfig.findUniqueOrThrow({ where: { id: 1 } })
      const params = {
        memoryCost: config.kdfMemoryCost,
        timeCost: config.kdfTimeCost,
        parallelism: config.kdfParallelism,
      }
      const main = unpack(Buffer.from(config.mainWrappedKey))

      // An attacker with the DB dump + all env vars tries guesses and raw keys: all fail.
      for (const guess of ['', 'password123456789', RECOVERY, PASSPHRASE.toUpperCase()]) {
        const kek = await deriveKek(guess, Buffer.from(config.mainSalt), params)
        expect(() => open(kek, main, 'da-vault/master-key/v1/main')).toThrow()
      }
      expect(() => open(randomBytes(32), main, 'da-vault/master-key/v1/main')).toThrow()

      // Only the real passphrase opens it — and the master key bytes appear nowhere in the DB.
      const kek = await deriveKek(PASSPHRASE, Buffer.from(config.mainSalt), params)
      const masterKey = open(kek, main, 'da-vault/master-key/v1/main')
      expect(masterKey.length).toBe(32)
      const dump = Buffer.concat([
        Buffer.from(config.mainWrappedKey),
        Buffer.from(config.recoveryWrappedKey),
        Buffer.from(config.mainSalt),
        Buffer.from(config.recoverySalt),
      ])
      expect(dump.includes(masterKey)).toBe(false)
    })
  })

  describe('unlock / lock', () => {
    it('unlocks with the passphrase, records events, and locks again', async () => {
      await initialised()
      const status = await vault.unlock({ passphrase: PASSPHRASE, actor: ACTOR })
      expect(status).toMatchObject({ unlocked: true, unlockedBy: ACTOR })
      await expect(vault.withMasterKey((mk) => mk.length)).resolves.toBe(32)

      expect(await vault.lock({ actor: ACTOR })).toMatchObject({ unlocked: false })
      await expect(vault.withMasterKey(() => 1)).rejects.toMatchObject({ code: 'VAULT_LOCKED' })

      const types = (
        await db.vaultEvent.findMany({ where: { actor: ACTOR }, orderBy: { sequence: 'asc' } })
      ).map((e) => e.type)
      expect(types.slice(-3)).toEqual(['INIT', 'UNLOCK', 'LOCK'])
    })

    it('rejects a wrong passphrase without revealing anything and throttles after 5 tries', async () => {
      await initialised()
      for (let i = 0; i < 5; i++) {
        await expect(
          vault.unlock({ passphrase: 'wrong passphrase number ' + i, actor: ACTOR }),
        ).rejects.toMatchObject({
          code: 'PASSPHRASE_INVALID',
          message: 'Wrong passphrase',
        })
      }
      // Even the right passphrase is refused during the cool-down.
      await expect(vault.unlock({ passphrase: PASSPHRASE, actor: ACTOR })).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      })
      clock += 15 * 60_000 + 1
      await expect(vault.unlock({ passphrase: PASSPHRASE, actor: ACTOR })).resolves.toMatchObject({
        unlocked: true,
      })
    })

    it('cannot be bypassed with parallel requests: attempts are evaluated one at a time', async () => {
      await initialised()
      const attacker = randomUUID()
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          vault.unlock({ passphrase: `parallel wrong guess ${i}`, actor: attacker }),
        ),
      )
      const codes = results.map((r) =>
        r.status === 'rejected' ? (r.reason as { code: string }).code : 'UNLOCKED',
      )
      expect(codes.filter((c) => c === 'PASSPHRASE_INVALID')).toHaveLength(5)
      expect(codes.filter((c) => c === 'RATE_LIMITED')).toHaveLength(7)
      expect(await db.vaultEvent.count({ where: { type: 'UNLOCK_FAILED', actor: attacker } })).toBe(
        5,
      )
    })

    it('auto-locks after the TTL and records AUTO_LOCK', async () => {
      await freshVault(10 * 60_000)
      await vault.init({ passphrase: PASSPHRASE, recoveryPassphrase: RECOVERY, actor: ACTOR })
      await vault.unlock({ passphrase: PASSPHRASE, actor: ACTOR })
      clock += 10 * 60_000
      expect(await vault.status()).toMatchObject({ unlocked: false })
      await new Promise((r) => setTimeout(r, 50)) // the AUTO_LOCK event is written asynchronously
      const last = await db.vaultEvent.findFirst({ orderBy: { sequence: 'desc' } })
      expect(last).toMatchObject({ type: 'AUTO_LOCK', actor: ACTOR })
    })

    it('reports NOT_INITIALIZED before setup', async () => {
      await freshVault()
      await expect(vault.unlock({ passphrase: PASSPHRASE, actor: ACTOR })).rejects.toMatchObject({
        code: 'VAULT_NOT_INITIALIZED',
      })
    })
  })

  describe('passphrase change & recovery', () => {
    it('changes the main passphrase; the old one stops working', async () => {
      await initialised()
      const next = 'copper meadow signal falcon'
      await vault.changePassphrase({
        currentPassphrase: PASSPHRASE,
        newPassphrase: next,
        actor: ACTOR,
      })
      await expect(vault.unlock({ passphrase: PASSPHRASE, actor: ACTOR })).rejects.toMatchObject({
        code: 'PASSPHRASE_INVALID',
      })
      await expect(vault.unlock({ passphrase: next, actor: ACTOR })).resolves.toMatchObject({
        unlocked: true,
      })
    })

    it('recovers with the offline recovery passphrase and keeps the same master key', async () => {
      await initialised()
      await vault.unlock({ passphrase: PASSPHRASE, actor: ACTOR })
      const before = await vault.withMasterKey((mk) => Buffer.from(mk).toString('hex'))
      await vault.lock({ actor: ACTOR })

      const fresh = 'granite willow comet saddle'
      await expect(
        vault.recover({
          recoveryPassphrase: 'not the recovery phrase',
          newPassphrase: fresh,
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ code: 'PASSPHRASE_INVALID' })
      await vault.recover({ recoveryPassphrase: RECOVERY, newPassphrase: fresh, actor: ACTOR })

      await vault.unlock({ passphrase: fresh, actor: ACTOR })
      const after = await vault.withMasterKey((mk) => Buffer.from(mk).toString('hex'))
      expect(after).toBe(before) // existing encrypted keys stay readable
      const types = (
        await db.vaultEvent.findMany({
          where: { actor: ACTOR },
          orderBy: { sequence: 'desc' },
          take: 3,
        })
      ).map((e) => e.type)
      expect(types).toContain('RECOVERED')
      expect(types).toContain('UNLOCK')
    })
  })

  describe('KDF parameters', () => {
    it('re-wraps with the STORED parameters, so raising the defaults later never locks the vault out', async () => {
      await initialised() // stored parameters: FAST_KDF
      const upgraded = createVaultService({
        repo: createVaultRepository(db),
        logger: createLogger({ name: 'signer-test', level: 'silent' }),
        unlockTtlMs: 60_000,
        kdf: { memoryCost: 8192, timeCost: 2, parallelism: 1 }, // new defaults in a later release
        now: () => clock,
      })
      try {
        const changed = 'copper meadow signal falcon'
        await upgraded.changePassphrase({
          currentPassphrase: PASSPHRASE,
          newPassphrase: changed,
          actor: ACTOR,
        })
        await expect(upgraded.unlock({ passphrase: changed, actor: ACTOR })).resolves.toMatchObject(
          { unlocked: true },
        )
        const recovered = 'granite willow comet saddle'
        await upgraded.recover({
          recoveryPassphrase: RECOVERY,
          newPassphrase: recovered,
          actor: ACTOR,
        })
        await expect(
          upgraded.unlock({ passphrase: recovered, actor: ACTOR }),
        ).resolves.toMatchObject({ unlocked: true })
        const config = await db.vaultConfig.findUniqueOrThrow({ where: { id: 1 } })
        expect(config).toMatchObject({ kdfMemoryCost: FAST_KDF.memoryCost, kdfTimeCost: 1 })
      } finally {
        upgraded.shutdown()
      }
    })
  })

  describe('vault_events', () => {
    it('is append-only at the database level', async () => {
      await initialised()
      const event = await db.vaultEvent.findFirstOrThrow({ where: { type: 'INIT' } })
      await expect(
        db.vaultEvent.update({ where: { id: event.id }, data: { actor: 'x' } }),
      ).rejects.toThrow(/append-only/)
      await expect(db.vaultEvent.deleteMany({})).rejects.toThrow(/append-only/)
      await expect(db.$executeRawUnsafe('TRUNCATE vault_events')).rejects.toThrow(/append-only/)
    })

    it('enforces the singleton config row', async () => {
      await initialised()
      await expect(
        db.$executeRawUnsafe(`UPDATE vault_config SET id = 2 WHERE id = 1`),
      ).rejects.toThrow()
    })
  })

  describe('HTTP API with HMAC', () => {
    async function app() {
      const { logger } = await freshVault()
      return buildSignerApp({
        logger,
        hmacSecret: SECRET,
        vault,
        keys: createKeyService({
          db,
          repo: createVaultRepository(db),
          vault,
          logger,
          revealEnabled: true,
        }),
        transactions: createTransactionSigner({
          source: null,
          db,
          repo: createVaultRepository(db),
          vault,
          logger,
        }),
        now: () => clock,
      })
    }

    function signed(
      method: 'GET' | 'POST',
      path: string,
      body?: object,
      overrides: { secret?: string; ts?: number } = {},
    ) {
      const payload = body === undefined ? '' : JSON.stringify(body)
      const headers = signRequest(overrides.secret ?? SECRET, {
        method,
        path,
        body: payload,
        timestamp: overrides.ts ?? clock,
      })
      return {
        method,
        url: path,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { payload }),
      }
    }

    it('serves signed requests end-to-end without echoing passphrases', async () => {
      const server = await app()
      const init = await server.inject(
        signed('POST', '/vault/init', {
          actor: ACTOR,
          passphrase: PASSPHRASE,
          recoveryPassphrase: RECOVERY,
        }),
      )
      expect(init.statusCode).toBe(200)
      expect(init.headers['cache-control']).toBe('no-store')
      const unlock = await server.inject(
        signed('POST', '/vault/unlock', { actor: ACTOR, passphrase: PASSPHRASE }),
      )
      expect(unlock.json()).toMatchObject({ unlocked: true })
      const bad = await server.inject(
        signed('POST', '/vault/unlock', { actor: ACTOR, passphrase: 'wrong but long enough' }),
      )
      expect(bad.statusCode).toBe(401)

      const output = logLines.join('') + init.body + unlock.body + bad.body
      expect(output).not.toContain(PASSPHRASE)
      expect(output).not.toContain(RECOVERY)
      expect(output).not.toContain('wrong but long enough')
      await server.close()
    })

    it.each([
      ['no signature', () => ({ method: 'GET' as const, url: '/vault/status' })],
      ['wrong secret', () => signed('GET', '/vault/status', undefined, { secret: 'z'.repeat(48) })],
      ['stale timestamp', () => signed('GET', '/vault/status', undefined, { ts: clock - 61_000 })],
    ])('rejects %s with 401', async (_label, build) => {
      const server = await app()
      expect((await server.inject(build())).statusCode).toBe(401)
      await server.close()
    })

    it('rejects a replayed request and a tampered body', async () => {
      const server = await app()
      const request = signed('GET', '/vault/status')
      expect((await server.inject(request)).statusCode).toBe(200)
      expect((await server.inject(request)).statusCode).toBe(401) // replay

      const tampered = signed('POST', '/vault/lock', { actor: ACTOR })
      tampered.payload = JSON.stringify({ actor: randomUUID() })
      expect((await server.inject(tampered)).statusCode).toBe(401)
      await server.close()
    })

    it('validation errors name fields but never echo values', async () => {
      const server = await app()
      const res = await server.inject(
        signed('POST', '/vault/unlock', { actor: 'not-a-uuid', passphrase: PASSPHRASE }),
      )
      expect(res.statusCode).toBe(400)
      expect(res.json().error.message).toBe('Invalid fields: actor')
      expect(res.body).not.toContain(PASSPHRASE)
      await server.close()
    })

    it('exposes liveness without a signature, and nothing else', async () => {
      const server = await app()
      expect((await server.inject({ method: 'GET', url: '/health' })).json()).toEqual({
        status: 'ok',
        service: 'signer',
      })
      await server.close()
    })
  })
})
