import { randomInt, randomUUID } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Role } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, PASSWORD, type Harness } from '../auth/harness'

/* PUBLIC TEST VECTORS (Hardhat / Anvil accounts #0 and #1) — published for testing, never real funds. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const testDatabaseUrl = inject('testDatabaseUrl')
const MFA_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'REVIEWER'])
const DOC_HASH = 'a'.repeat(64)

describe.skipIf(!testDatabaseUrl)('ownership verification API', () => {
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

  async function inventoryAddress(opts: { archived?: boolean } = {}) {
    const network = await db.network.create({
      data: {
        name: `own-${randomUUID().slice(0, 8)}`,
        displayName: 'Ownership net',
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

  async function createAuthorization(token: string, addressId: string, body: object = {}) {
    const res = await h.call('POST', `/api/addresses/${addressId}/authorizations`, token, {
      type: 'SELF',
      reference: 'Own wallet since 2017',
      documentSha256: DOC_HASH,
      documentName: 'statement.pdf',
      ...body,
    })
    return res
  }

  async function challengeFor(token: string, authorizationId: string) {
    const res = await h.call('POST', `/api/authorizations/${authorizationId}/challenges`, token, {})
    expect(res.statusCode).toBe(201)
    return res.json().challenge as {
      id: string
      message: string
      address: string
      expiresAt: string
    }
  }

  describe('access control', () => {
    it.each([
      ['SUPER_ADMIN', { list: 200, create: 201 }],
      ['ADMIN', { list: 200, create: 403 }],
      ['ANALYST', { list: 200, create: 201 }],
      ['REVIEWER', { list: 200, create: 403 }],
      ['AUDITOR', { list: 200, create: 403 }],
    ] as const)('%s → authorizations %j', async (role, expected) => {
      h = await createHarness(db)
      const { token } = await tokenFor(role)
      const address = await inventoryAddress()
      expect((await h.call('GET', '/api/authorizations', token)).statusCode).toBe(expected.list)
      expect(
        (await h.call('GET', `/api/addresses/${address.id}/authorizations`, token)).statusCode,
      ).toBe(expected.list)
      expect((await createAuthorization(token, address.id)).statusCode).toBe(expected.create)
    })

    it.each(['ADMIN', 'ANALYST', 'REVIEWER', 'AUDITOR'] as const)(
      '%s is denied the vault path (and, without ownership:verify, challenges and signatures)',
      async (role) => {
        h = await createHarness(db)
        const { token: analyst } = await tokenFor('ANALYST')
        const address = await inventoryAddress()
        const authorization = (await createAuthorization(analyst, address.id)).json().authorization
        const challenge = await challengeFor(analyst, authorization.id)

        const { token } = await tokenFor(role)
        expect(
          (await h.call('POST', `/api/challenges/${challenge.id}/vault-signature`, token, {}))
            .statusCode,
        ).toBe(403)
        if (role === 'ANALYST') return
        expect(
          (await h.call('POST', `/api/authorizations/${authorization.id}/challenges`, token, {}))
            .statusCode,
        ).toBe(403)
        expect(
          (
            await h.call('POST', `/api/challenges/${challenge.id}/signature`, token, {
              signature: '0x00',
              method: 'MANUAL',
            })
          ).statusCode,
        ).toBe(403)
      },
    )

    it('rejects anonymous requests', async () => {
      h = await createHarness(db)
      const address = await inventoryAddress()
      expect((await h.call('GET', '/api/authorizations')).statusCode).toBe(401)
      expect(
        (await createAuthorization(undefined as unknown as string, address.id)).statusCode,
      ).toBe(401)
    })
  })

  describe('authorization records', () => {
    it('creates a PENDING authorization, moves the address to PENDING and audits it', async () => {
      h = await createHarness(db)
      const { user, token } = await tokenFor('ANALYST')
      const address = await inventoryAddress()
      const res = await createAuthorization(token, address.id, {
        documentSha256: DOC_HASH.toUpperCase(),
      })
      expect(res.statusCode).toBe(201)
      const authorization = res.json().authorization
      expect(authorization).toMatchObject({
        type: 'SELF',
        status: 'PENDING',
        documentSha256: DOC_HASH,
        documentName: 'statement.pdf',
        address: { id: address.id, address: TEST_ADDRESS },
      })
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: address.id } })).authorizationStatus,
      ).toBe('PENDING')
      const audit = await db.auditLog.findFirst({
        where: { userId: user.id, action: 'AUTHORIZATION_CREATED' },
      })
      expect(audit?.resourceId).toBe(authorization.id)

      const list = await h.call('GET', `/api/addresses/${address.id}/authorizations`, token)
      expect(list.json().authorizations).toHaveLength(1)
    })

    it('validates input and refuses archived addresses', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const address = await inventoryAddress()
      expect(
        (await createAuthorization(token, address.id, { documentSha256: 'not-a-hash' })).statusCode,
      ).toBe(400)
      expect((await createAuthorization(token, address.id, { reference: '' })).statusCode).toBe(400)
      expect((await createAuthorization(token, address.id, { type: 'GUESS' })).statusCode).toBe(400)
      expect(
        (
          await createAuthorization(token, address.id, {
            expiresAt: new Date(h.now().getTime() - 1000).toISOString(),
          })
        ).statusCode,
      ).toBe(400)
      expect((await createAuthorization(token, randomUUID())).statusCode).toBe(404)
      const archived = await inventoryAddress({ archived: true })
      expect((await createAuthorization(token, archived.id)).statusCode).toBe(409)
    })
  })

  describe('signed challenges', () => {
    it('issues a challenge with the standard message and verifies a wallet signature', async () => {
      h = await createHarness(db)
      const { user, token } = await tokenFor('ANALYST')
      const address = await inventoryAddress()
      const authorization = (await createAuthorization(token, address.id)).json().authorization
      const challenge = await challengeFor(token, authorization.id)
      expect(challenge.message).toContain('Digital Archaeology — Ownership Verification')
      expect(challenge.message).toContain(`Address: ${TEST_ADDRESS}`)
      expect(challenge.message).toContain(
        `Purpose: Verify ownership for authorization ${authorization.id}`,
      )
      expect(challenge.message).toMatch(/Nonce: [0-9a-f]{64}/)

      const signature = await privateKeyToAccount(TEST_KEY).signMessage({
        message: challenge.message,
      })
      const res = await h.call('POST', `/api/challenges/${challenge.id}/signature`, token, {
        signature,
        method: 'WALLET',
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        result: 'VERIFIED',
        authorization: { status: 'VERIFIED' },
      })
      expect(res.json().authorization.verifiedAt).toBeTruthy()

      const stored = await db.ownershipChallenge.findUniqueOrThrow({ where: { id: challenge.id } })
      expect(stored).toMatchObject({ result: 'VERIFIED', method: 'WALLET', signature })
      expect(stored.usedAt).not.toBeNull()
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: address.id } })).authorizationStatus,
      ).toBe('VERIFIED')
      const actions = (await db.auditLog.findMany({ where: { userId: user.id } })).map(
        (a) => a.action,
      )
      expect(actions).toEqual(
        expect.arrayContaining([
          'AUTHORIZATION_CREATED',
          'OWNERSHIP_CHALLENGE_CREATED',
          'OWNERSHIP_VERIFIED',
        ]),
      )

      // A later authorization does not downgrade a verified address.
      await createAuthorization(token, address.id, { type: 'MANDATE', reference: 'Second mandate' })
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: address.id } })).authorizationStatus,
      ).toBe('VERIFIED')
    })

    it('rejects a signature from another key and keeps the authorization pending', async () => {
      h = await createHarness(db)
      const { user, token } = await tokenFor('ANALYST')
      const address = await inventoryAddress()
      const authorization = (await createAuthorization(token, address.id)).json().authorization
      const challenge = await challengeFor(token, authorization.id)

      const signature = await privateKeyToAccount(OTHER_KEY).signMessage({
        message: challenge.message,
      })
      const res = await h.call('POST', `/api/challenges/${challenge.id}/signature`, token, {
        signature,
        method: 'MANUAL',
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('SIGNATURE_INVALID')
      expect(
        (await db.ownershipChallenge.findUniqueOrThrow({ where: { id: challenge.id } })).result,
      ).toBe('REJECTED')
      expect(
        (await db.authorization.findUniqueOrThrow({ where: { id: authorization.id } }))
          .verificationStatus,
      ).toBe('PENDING')
      expect(
        await db.auditLog.count({ where: { userId: user.id, action: 'OWNERSHIP_REJECTED' } }),
      ).toBe(1)
    })

    it('rejects a signature over a different message and malformed signatures', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const address = await inventoryAddress()
      const authorization = (await createAuthorization(token, address.id)).json().authorization
      const first = await challengeFor(token, authorization.id)
      const second = await challengeFor(token, authorization.id)

      // Signing an older challenge cannot verify a newer one (nonce binding).
      const signature = await privateKeyToAccount(TEST_KEY).signMessage({ message: first.message })
      const res = await h.call('POST', `/api/challenges/${second.id}/signature`, token, {
        signature,
        method: 'WALLET',
      })
      expect(res.json().error.code).toBe('SIGNATURE_INVALID')

      const malformed = await h.call('POST', `/api/challenges/${first.id}/signature`, token, {
        signature: '0xdeadbeef',
        method: 'MANUAL',
      })
      expect(malformed.json().error.code).toBe('SIGNATURE_INVALID')
      expect(
        (await db.ownershipChallenge.findUniqueOrThrow({ where: { id: first.id } })).signature,
      ).toBeNull()
    })

    it('is single use: a challenge cannot be retried, even with a valid signature', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const address = await inventoryAddress()
      const authorization = (await createAuthorization(token, address.id)).json().authorization
      const challenge = await challengeFor(token, authorization.id)
      const good = await privateKeyToAccount(TEST_KEY).signMessage({ message: challenge.message })
      const bad = await privateKeyToAccount(OTHER_KEY).signMessage({ message: challenge.message })

      expect(
        (
          await h.call('POST', `/api/challenges/${challenge.id}/signature`, token, {
            signature: bad,
            method: 'WALLET',
          })
        ).statusCode,
      ).toBe(400)
      const retry = await h.call('POST', `/api/challenges/${challenge.id}/signature`, token, {
        signature: good,
        method: 'WALLET',
      })
      expect(retry.statusCode).toBe(409)
      expect(
        (await db.authorization.findUniqueOrThrow({ where: { id: authorization.id } }))
          .verificationStatus,
      ).toBe('PENDING')
    })

    it('expires challenges after the TTL', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const address = await inventoryAddress()
      const authorization = (await createAuthorization(token, address.id)).json().authorization
      const challenge = await challengeFor(token, authorization.id)
      const signature = await privateKeyToAccount(TEST_KEY).signMessage({
        message: challenge.message,
      })

      h.advance(16 * 60_000)
      const res = await h.call('POST', `/api/challenges/${challenge.id}/signature`, token, {
        signature,
        method: 'WALLET',
      })
      expect(res.statusCode).toBe(409)
      expect(
        (await db.ownershipChallenge.findUniqueOrThrow({ where: { id: challenge.id } })).result,
      ).toBe('EXPIRED')
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: address.id } })).authorizationStatus,
      ).toBe('PENDING')
    })

    it('refuses challenges for expired authorizations and reports them as EXPIRED', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const address = await inventoryAddress()
      const authorization = (
        await createAuthorization(token, address.id, {
          expiresAt: new Date(h.now().getTime() + 60 * 60_000).toISOString(),
        })
      ).json().authorization
      h.advance(2 * 60 * 60_000)
      const { token: token2 } = await tokenFor('ANALYST')
      expect(
        (await h.call('POST', `/api/authorizations/${authorization.id}/challenges`, token2, {}))
          .statusCode,
      ).toBe(409)
      const list = await h.call('GET', `/api/addresses/${address.id}/authorizations`, token2)
      expect(list.json().authorizations[0].status).toBe('EXPIRED')
    })

    it('does not verify when the authorization expires while a challenge is open', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const address = await inventoryAddress()
      const authorization = (
        await createAuthorization(token, address.id, {
          expiresAt: new Date(h.now().getTime() + 5 * 60_000).toISOString(),
        })
      ).json().authorization
      const challenge = await challengeFor(token, authorization.id)
      const signature = await privateKeyToAccount(TEST_KEY).signMessage({
        message: challenge.message,
      })
      h.advance(10 * 60_000) // challenge (15 min) still open, authorization (5 min) expired
      const res = await h.call('POST', `/api/challenges/${challenge.id}/signature`, token, {
        signature,
        method: 'WALLET',
      })
      expect(res.statusCode).toBe(409)
      expect(
        (await db.authorization.findUniqueOrThrow({ where: { id: authorization.id } }))
          .verificationStatus,
      ).toBe('PENDING')
    })
  })

  describe('vault signing (SUPER_ADMIN)', () => {
    async function superAdminWithKey() {
      const { user, token } = await tokenFor('SUPER_ADMIN')
      const address = await inventoryAddress()
      expect(
        (
          await h.call('POST', '/api/vault/init', token, {
            passphrase: 'marble orbit cactus lantern',
            recoveryPassphrase: 'violet harbor tundra pencil quartz',
          })
        ).statusCode,
      ).toBe(200)
      expect(
        (
          await h.call('POST', '/api/vault/unlock', token, {
            passphrase: 'marble orbit cactus lantern',
          })
        ).statusCode,
      ).toBe(200)
      expect(
        (
          await h.call('POST', '/api/vault/keys', token, {
            addressId: address.id,
            secretType: 'PRIVATE_KEY',
            secret: TEST_KEY,
          })
        ).statusCode,
      ).toBe(201)
      return { user, token, secret: user.secret!, address }
    }

    it('signs the challenge with the stored key and verifies it, without leaking secrets', async () => {
      h = await createHarness(db)
      const { user, token, address } = await superAdminWithKey()
      const authorization = (await createAuthorization(token, address.id)).json().authorization
      const challenge = await challengeFor(token, authorization.id)

      const res = await h.call('POST', `/api/challenges/${challenge.id}/vault-signature`, token, {})
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        result: 'VERIFIED',
        authorization: { status: 'VERIFIED' },
      })
      expect(JSON.stringify(res.json())).not.toContain(TEST_KEY.slice(2))
      expect(
        (await db.ownershipChallenge.findUniqueOrThrow({ where: { id: challenge.id } })).method,
      ).toBe('VAULT')
      expect(h.signer.calls).toContain('signChallenge')

      const audits = JSON.stringify(
        await db.auditLog.findMany({ where: { userId: user.id } }),
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      )
      expect(audits).not.toContain(TEST_KEY.slice(2))
      expect(h.logs()).not.toContain(TEST_KEY.slice(2))
    })

    it('requires a recent re-authentication and an unlocked vault', async () => {
      h = await createHarness(db)
      const { token, secret, address } = await superAdminWithKey()
      const authorization = (await createAuthorization(token, address.id)).json().authorization
      const challenge = await challengeFor(token, authorization.id)

      h.advance(6 * 60_000)
      const stale = await h.call(
        'POST',
        `/api/challenges/${challenge.id}/vault-signature`,
        token,
        {},
      )
      expect(stale.json().error.code).toBe('REAUTH_REQUIRED')
      expect(h.signer.calls).not.toContain('signChallenge')

      expect(
        (
          await h.call('POST', '/api/auth/reauth', token, {
            password: PASSWORD,
            code: h.code(secret),
          })
        ).statusCode,
      ).toBe(204)
      expect((await h.call('POST', '/api/vault/lock', token, {})).statusCode).toBe(200)
      const locked = await h.call(
        'POST',
        `/api/challenges/${challenge.id}/vault-signature`,
        token,
        {},
      )
      expect(locked.json().error.code).toBe('VAULT_LOCKED')
      // A failed vault call does not burn the challenge.
      expect(
        (await db.ownershipChallenge.findUniqueOrThrow({ where: { id: challenge.id } })).usedAt,
      ).toBeNull()
    })
  })
})
