import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Role } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, PASSWORD, type Harness } from '../auth/harness'

/* PUBLIC TEST VECTORS (Hardhat / Anvil account #0) — published for testing, never real funds. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

const testDatabaseUrl = inject('testDatabaseUrl')
const MFA_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'REVIEWER'])
const VAULT_PASSPHRASE = 'marble orbit cactus lantern'
const RECOVERY = 'violet harbor tundra pencil quartz'

describe.skipIf(!testDatabaseUrl)('key vault API', () => {
  let db: Database
  let h: Harness

  beforeAll(() => {
    db = createPrismaClient(testDatabaseUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })
  afterEach(async () => {
    await h?.app.close()
  })

  async function tokenFor(role: Role) {
    const user = await h.createUser([role], { mfa: MFA_ROLES.has(role) })
    return { user, token: await h.activeSession(user) }
  }

  /** An inventory entry for the public test address on a fresh network. */
  async function inventoryAddress(opts: { archived?: boolean } = {}) {
    const network = await db.network.create({
      data: {
        name: `vault-${randomUUID().slice(0, 8)}`,
        displayName: 'Vault net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: true,
        assets: { create: [{ isNative: true, symbol: 'ETH', name: 'Ether', decimals: 18 }] },
      },
    })
    return db.address.create({
      data: {
        networkId: network.id,
        address: TEST_ADDRESS,
        label: 'Old hardware wallet',
        ownerReference: 'SELF',
        archivedAt: opts.archived ? new Date() : null,
      },
    })
  }

  async function superAdmin() {
    const { user, token } = await tokenFor('SUPER_ADMIN')
    return { user, token, secret: user.secret! }
  }

  async function initAndUnlock(token: string) {
    expect(
      (
        await h.call('POST', '/api/vault/init', token, {
          passphrase: VAULT_PASSPHRASE,
          recoveryPassphrase: RECOVERY,
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (await h.call('POST', '/api/vault/unlock', token, { passphrase: VAULT_PASSPHRASE }))
        .statusCode,
    ).toBe(200)
  }

  describe('access control', () => {
    it.each([
      ['SUPER_ADMIN', 200],
      ['ADMIN', 403],
      ['ANALYST', 403],
      ['REVIEWER', 403],
      ['AUDITOR', 403],
    ] as const)('%s → GET /api/vault/status %i', async (role, expected) => {
      h = await createHarness(db)
      const { token } = await tokenFor(role)
      const res = await h.call('GET', '/api/vault/status', token)
      expect(res.statusCode).toBe(expected)
      expect(res.headers['cache-control']).toBe('no-store')
    })

    it('rejects anonymous requests and non-SUPER_ADMIN imports', async () => {
      h = await createHarness(db)
      expect((await h.call('GET', '/api/vault/keys')).statusCode).toBe(401)
      const { token } = await tokenFor('ADMIN')
      const address = await inventoryAddress()
      const res = await h.call('POST', '/api/vault/keys', token, {
        addressId: address.id,
        secretType: 'PRIVATE_KEY',
        secret: TEST_KEY,
      })
      expect(res.statusCode).toBe(403)
      expect(h.signer.calls).not.toContain('importKey')
    })

    it('requires a recent re-authentication for sensitive actions, but not for locking', async () => {
      h = await createHarness(db)
      const { token, secret } = await superAdmin()
      h.advance(6 * 60_000) // the login's MFA confirmation is now older than 5 minutes

      const unlock = await h.call('POST', '/api/vault/init', token, {
        passphrase: VAULT_PASSPHRASE,
        recoveryPassphrase: RECOVERY,
      })
      expect(unlock.statusCode).toBe(403)
      expect(unlock.json().error.code).toBe('REAUTH_REQUIRED')
      expect(h.signer.calls).not.toContain('init')
      expect((await h.call('POST', '/api/vault/lock', token, {})).statusCode).toBe(200)

      const reauth = await h.call('POST', '/api/auth/reauth', token, {
        password: PASSWORD,
        code: h.code(secret),
      })
      expect(reauth.statusCode).toBe(204)
      expect(
        (
          await h.call('POST', '/api/vault/init', token, {
            passphrase: VAULT_PASSPHRASE,
            recoveryPassphrase: RECOVERY,
          })
        ).statusCode,
      ).toBe(200)
    })
  })

  describe('lifecycle', () => {
    it('initialises, unlocks, imports a key that matches the inventory, and lists it', async () => {
      h = await createHarness(db)
      const { user, token } = await superAdmin()
      const address = await inventoryAddress()
      await initAndUnlock(token)

      const imported = await h.call('POST', '/api/vault/keys', token, {
        addressId: address.id,
        secretType: 'PRIVATE_KEY',
        secret: TEST_KEY,
      })
      expect(imported.statusCode).toBe(201)
      expect(imported.body).not.toContain(TEST_KEY.slice(2))

      const keys = (await h.call('GET', '/api/vault/keys', token)).json().keys
      const key = keys.find((k: { address: string }) => k.address === TEST_ADDRESS.toLowerCase())
      expect(key).toMatchObject({ checksumAddress: TEST_ADDRESS, keyType: 'PRIVATE_KEY' })
      // The same EVM key covers this address on every network where it is registered.
      expect(key.inventory).toContainEqual(
        expect.objectContaining({
          addressId: address.id,
          label: 'Old hardware wallet',
          archived: false,
        }),
      )

      const actions = (
        await db.auditLog.findMany({ where: { userId: user.id }, orderBy: { sequence: 'asc' } })
      ).map((a) => a.action)
      expect(actions).toEqual(
        expect.arrayContaining(['VAULT_INITIALIZED', 'VAULT_UNLOCKED', 'KEY_IMPORTED']),
      )
    })

    it('imports from a seed phrase (signer derives; only the key is kept)', async () => {
      h = await createHarness(db)
      const { token } = await superAdmin()
      const address = await inventoryAddress()
      await initAndUnlock(token)
      const res = await h.call('POST', '/api/vault/keys', token, {
        addressId: address.id,
        secretType: 'MNEMONIC',
        secret: TEST_MNEMONIC,
        derivationPath: "m/44'/60'/0'/0/0",
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().key).toMatchObject({ keyType: 'DERIVED_FROM_MNEMONIC' })
    })

    it('refuses keys for unknown or archived inventory entries and mismatching keys', async () => {
      h = await createHarness(db)
      const { user, token } = await superAdmin()
      await initAndUnlock(token)
      const unknown = await h.call('POST', '/api/vault/keys', token, {
        addressId: randomUUID(),
        secretType: 'PRIVATE_KEY',
        secret: TEST_KEY,
      })
      expect(unknown.statusCode).toBe(404)
      const archived = await inventoryAddress({ archived: true })
      expect(
        (
          await h.call('POST', '/api/vault/keys', token, {
            addressId: archived.id,
            secretType: 'PRIVATE_KEY',
            secret: TEST_KEY,
          })
        ).statusCode,
      ).toBe(409)

      const other = await inventoryAddress()
      const wrongKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // public Hardhat account #1
      const mismatch = await h.call('POST', '/api/vault/keys', token, {
        addressId: other.id,
        secretType: 'PRIVATE_KEY',
        secret: wrongKey,
      })
      expect(mismatch.statusCode).toBe(400)
      expect(mismatch.json().error.code).toBe('KEY_ADDRESS_MISMATCH')
      const failure = await db.auditLog.findFirst({
        where: { userId: user.id, action: 'KEY_IMPORTED_FAILED' },
      })
      expect(failure?.metadata).toMatchObject({
        code: 'KEY_ADDRESS_MISMATCH',
        secretType: 'PRIVATE_KEY',
      })
    })

    it('audits a wrong passphrase as DENIED', async () => {
      h = await createHarness(db)
      const { user, token } = await superAdmin()
      await h.call('POST', '/api/vault/init', token, {
        passphrase: VAULT_PASSPHRASE,
        recoveryPassphrase: RECOVERY,
      })
      const res = await h.call('POST', '/api/vault/unlock', token, {
        passphrase: 'definitely not it at all',
      })
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('PASSPHRASE_INVALID')
      const entry = await db.auditLog.findFirst({
        where: { userId: user.id, action: 'VAULT_UNLOCKED_FAILED' },
      })
      expect(entry?.result).toBe('DENIED')
    })

    it('locks the vault when the SUPER_ADMIN logs out', async () => {
      h = await createHarness(db)
      const { token } = await superAdmin()
      await initAndUnlock(token)
      expect(h.signer.isUnlocked()).toBe(true)
      expect((await h.call('POST', '/api/auth/logout', token, {})).statusCode).toBe(204)
      expect(h.signer.isUnlocked()).toBe(false)
    })

    it('answers SIGNER_UNAVAILABLE when the signer is down', async () => {
      h = await createHarness(db)
      const { token } = await superAdmin()
      h.signer.setAvailable(false)
      const res = await h.call('GET', '/api/vault/status', token)
      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('SIGNER_UNAVAILABLE')
    })
  })

  describe('break-glass reveal', () => {
    async function withImportedKey() {
      h = await createHarness(db)
      const admin = await superAdmin()
      const address = await inventoryAddress()
      await initAndUnlock(admin.token)
      await h.call('POST', '/api/vault/keys', admin.token, {
        addressId: address.id,
        secretType: 'PRIVATE_KEY',
        secret: TEST_KEY,
      })
      h.advance(31_000) // next TOTP window: the login code is already consumed
      return { ...admin, address }
    }

    it('needs a fresh TOTP code AND the passphrase, then returns the key with no-store', async () => {
      const { token, secret, address } = await withImportedKey()

      const noCode = await h.call('POST', '/api/vault/keys/reveal', token, {
        addressId: address.id,
        passphrase: VAULT_PASSPHRASE,
      })
      expect(noCode.statusCode).toBe(400)
      const badCode = await h.call('POST', '/api/vault/keys/reveal', token, {
        addressId: address.id,
        passphrase: VAULT_PASSPHRASE,
        code: '000000',
      })
      expect(badCode.json().error.code).toBe('MFA_INVALID')
      expect(h.signer.calls).not.toContain('revealKey')

      const ok = await h.call('POST', '/api/vault/keys/reveal', token, {
        addressId: address.id,
        passphrase: VAULT_PASSPHRASE,
        code: h.code(secret),
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json()).toEqual({ privateKey: TEST_KEY })
      expect(ok.headers['cache-control']).toBe('no-store')

      // The same code cannot be replayed for a second reveal.
      const replay = await h.call('POST', '/api/vault/keys/reveal', token, {
        addressId: address.id,
        passphrase: VAULT_PASSPHRASE,
        code: h.code(secret),
      })
      expect(replay.json().error.code).toBe('MFA_INVALID')
    })

    it('never writes the key, passphrase or seed to logs or the audit trail', async () => {
      const { user, token, secret, address } = await withImportedKey()
      await h.call('POST', '/api/vault/keys/reveal', token, {
        addressId: address.id,
        passphrase: VAULT_PASSPHRASE,
        code: h.code(secret),
      })

      const audits = await db.auditLog.findMany({ where: { userId: user.id } })
      expect(audits.map((a) => a.action)).toContain('KEY_REVEALED')
      const everything =
        h.logs() + JSON.stringify(audits, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
      for (const secretValue of [TEST_KEY.slice(2), VAULT_PASSPHRASE, RECOVERY]) {
        expect(everything).not.toContain(secretValue)
      }
    })
  })
})
