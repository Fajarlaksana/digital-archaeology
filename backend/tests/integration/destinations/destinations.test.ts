import { randomInt, randomUUID } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Role } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, PASSWORD, type Harness } from '../auth/harness'

/* PUBLIC TEST VECTORS (Hardhat / Anvil accounts #1 and #2) — published for testing, never real funds. */
const DEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const DEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const OTHER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

const testDatabaseUrl = inject('testDatabaseUrl')
const MFA_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'REVIEWER'])

describe.skipIf(!testDatabaseUrl)('destination whitelist API', () => {
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

  async function userWith(roles: Role[]) {
    const user = await h.createUser(roles, { mfa: roles.some((r) => MFA_ROLES.has(r)) })
    return { user, token: await h.activeSession(user) }
  }

  async function network(opts: { disabled?: boolean } = {}) {
    return db.network.create({
      data: {
        name: `dest-${randomUUID().slice(0, 8)}`,
        displayName: 'Destination net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: true,
        status: opts.disabled ? 'DISABLED' : 'ACTIVE',
        assets: { create: [{ isNative: true, symbol: 'ETH', name: 'Ether', decimals: 18 }] },
      },
    })
  }

  async function createDestination(token: string, body: Record<string, unknown> = {}) {
    const networkId = body.networkId ?? (await network()).id
    return h.call('POST', '/api/destinations', token, {
      networkId,
      address: DEST_ADDRESS.toLowerCase(),
      label: 'Cold storage 2026',
      ...body,
    })
  }

  /** ANALYST creates a destination and proves control with the destination key. */
  async function provenDestination(analystToken: string) {
    const destination = (await createDestination(analystToken)).json().destination
    const challenge = (
      await h.call('POST', `/api/destinations/${destination.id}/challenges`, analystToken, {})
    ).json().challenge
    const signature = await privateKeyToAccount(DEST_KEY).signMessage({
      message: challenge.message,
    })
    const res = await h.call(
      'POST',
      `/api/destination-challenges/${challenge.id}/signature`,
      analystToken,
      { signature, method: 'WALLET' },
    )
    expect(res.statusCode).toBe(200)
    return destination as { id: string }
  }

  describe('access control', () => {
    it.each([
      ['SUPER_ADMIN', { list: 200, create: 403, approve: 403 }],
      ['ADMIN', { list: 200, create: 403, approve: 403 }],
      ['ANALYST', { list: 200, create: 201, approve: 403 }],
      ['REVIEWER', { list: 200, create: 403, approve: 409 }],
      ['AUDITOR', { list: 200, create: 403, approve: 403 }],
    ] as const)('%s → destinations %j', async (role, expected) => {
      h = await createHarness(db)
      const { token: analyst } = await userWith(['ANALYST'])
      const existing = (await createDestination(analyst)).json().destination
      const { token } = await userWith([role])

      expect((await h.call('GET', '/api/destinations', token)).statusCode).toBe(expected.list)
      expect((await h.call('GET', `/api/destinations/${existing.id}`, token)).statusCode).toBe(
        expected.list,
      )
      expect((await createDestination(token)).statusCode).toBe(expected.create)
      // REVIEWER may decide, but this destination has no proof yet → 409.
      expect(
        (await h.call('POST', `/api/destinations/${existing.id}/approve`, token, {})).statusCode,
      ).toBe(expected.approve)
      for (const action of ['reject', 'disable']) {
        const res = await h.call('POST', `/api/destinations/${existing.id}/${action}`, token, {
          reason: 'not ours',
        })
        expect(res.statusCode === 403).toBe(role !== 'REVIEWER')
      }
    })

    it('rejects anonymous requests', async () => {
      h = await createHarness(db)
      expect((await h.call('GET', '/api/destinations')).statusCode).toBe(401)
      expect((await h.call('POST', '/api/destinations', undefined, {})).statusCode).toBe(401)
    })
  })

  describe('creation', () => {
    it('stores the canonical address as PENDING_APPROVAL with an open approval request', async () => {
      h = await createHarness(db)
      const { user, token } = await userWith(['ANALYST'])
      const res = await createDestination(token)
      expect(res.statusCode).toBe(201)
      const destination = res.json().destination
      expect(destination).toMatchObject({
        address: DEST_ADDRESS, // EIP-55 checksum from the chain adapter
        label: 'Cold storage 2026',
        status: 'PENDING_APPROVAL',
        controlVerifiedAt: null,
        createdBy: { id: user.id },
      })
      expect(destination.approvals).toEqual([
        expect.objectContaining({
          requestedBy: expect.objectContaining({ id: user.id }),
          decision: null,
        }),
      ])
      expect(
        await db.auditLog.count({ where: { userId: user.id, action: 'DESTINATION_CREATED' } }),
      ).toBe(1)
    })

    it('validates the address, label and network, and refuses duplicates', async () => {
      h = await createHarness(db)
      const { token } = await userWith(['ANALYST'])
      const net = await network()
      expect((await createDestination(token, { networkId: net.id })).statusCode).toBe(201)
      expect((await createDestination(token, { networkId: net.id })).statusCode).toBe(409)
      const badChecksum = await createDestination(token, {
        address: '0x70997970c51812DC3A010C7d01b50e0d17dc79C8',
      })
      expect(badChecksum.json().error.code).toBe('INVALID_ADDRESS')
      expect(
        (await createDestination(token, { address: '0x' + '0'.repeat(40) })).json().error.code,
      ).toBe('INVALID_ADDRESS')
      expect((await createDestination(token, { label: '  ' })).statusCode).toBe(400)
      const disabled = await network({ disabled: true })
      expect((await createDestination(token, { networkId: disabled.id })).json().error.code).toBe(
        'INVALID_NETWORK',
      )
    })
  })

  describe('proof of control', () => {
    it('verifies a signature from the destination key', async () => {
      h = await createHarness(db)
      const { user, token } = await userWith(['ANALYST'])
      const destination = await provenDestination(token)
      const stored = await db.destination.findUniqueOrThrow({ where: { id: destination.id } })
      expect(stored.controlVerifiedAt).not.toBeNull()
      expect(stored.controlVerifiedById).toBe(user.id)
      expect(stored.status).toBe('PENDING_APPROVAL') // proof alone never approves
      const challenge = await db.destinationChallenge.findFirstOrThrow({
        where: { destinationId: destination.id },
      })
      expect(challenge).toMatchObject({ result: 'VERIFIED', method: 'WALLET' })
      expect(challenge.message.split('\n')[0]).toBe(
        'Digital Archaeology — Destination Verification',
      )
    })

    it('rejects another key, is single use, and expires', async () => {
      h = await createHarness(db)
      const { token } = await userWith(['ANALYST'])
      const destination = (await createDestination(token)).json().destination
      const newChallenge = async () =>
        (await h.call('POST', `/api/destinations/${destination.id}/challenges`, token, {})).json()
          .challenge
      const submit = (challengeId: string, signature: string) =>
        h.call('POST', `/api/destination-challenges/${challengeId}/signature`, token, {
          signature,
          method: 'MANUAL',
        })

      const first = await newChallenge()
      const wrong = await privateKeyToAccount(OTHER_KEY).signMessage({ message: first.message })
      expect((await submit(first.id, wrong)).json().error.code).toBe('SIGNATURE_INVALID')
      const right = await privateKeyToAccount(DEST_KEY).signMessage({ message: first.message })
      expect((await submit(first.id, right)).statusCode).toBe(409) // already used

      const second = await newChallenge()
      const late = await privateKeyToAccount(DEST_KEY).signMessage({ message: second.message })
      h.advance(16 * 60_000)
      const { token: fresh } = await userWith(['ANALYST'])
      const expired = await h.call(
        'POST',
        `/api/destination-challenges/${second.id}/signature`,
        fresh,
        { signature: late, method: 'WALLET' },
      )
      expect(expired.statusCode).toBe(409)
      expect(
        (await db.destination.findUniqueOrThrow({ where: { id: destination.id } }))
          .controlVerifiedAt,
      ).toBeNull()
    })
  })

  describe('approval (maker-checker)', () => {
    it('a different REVIEWER approves a proven destination after re-authentication', async () => {
      h = await createHarness(db)
      const { token: analyst } = await userWith(['ANALYST'])
      const destination = await provenDestination(analyst)
      const { user: reviewer, token } = await userWith(['REVIEWER'])

      h.advance(6 * 60_000)
      const stale = await h.call('POST', `/api/destinations/${destination.id}/approve`, token, {})
      expect(stale.json().error.code).toBe('REAUTH_REQUIRED')
      expect(
        (
          await h.call('POST', '/api/auth/reauth', token, {
            password: PASSWORD,
            code: h.code(reviewer.secret!),
          })
        ).statusCode,
      ).toBe(204)

      const res = await h.call('POST', `/api/destinations/${destination.id}/approve`, token, {
        note: 'Matches the hardware wallet label',
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().destination).toMatchObject({ status: 'APPROVED' })
      expect(res.json().destination.approvals[0]).toMatchObject({
        decision: 'APPROVED',
        decidedBy: { id: reviewer.id },
        reason: 'Matches the hardware wallet label',
      })
      expect(
        await db.auditLog.count({ where: { userId: reviewer.id, action: 'DESTINATION_APPROVED' } }),
      ).toBe(1)
      // Decided once: a second approval attempt is a conflict.
      expect(
        (await h.call('POST', `/api/destinations/${destination.id}/approve`, token, {})).statusCode,
      ).toBe(409)
    })

    it('refuses approval without a proof of control', async () => {
      h = await createHarness(db)
      const { token: analyst } = await userWith(['ANALYST'])
      const destination = (await createDestination(analyst)).json().destination
      const { token } = await userWith(['REVIEWER'])
      const res = await h.call('POST', `/api/destinations/${destination.id}/approve`, token, {})
      expect(res.statusCode).toBe(409)
      expect(res.json().error.message).toMatch(/not been proven/)
    })

    it('the requester or the prover can never decide, even holding REVIEWER', async () => {
      h = await createHarness(db)
      const { token: both } = await userWith(['ANALYST', 'REVIEWER'])
      const own = await provenDestination(both) // requested AND proved by the same person
      for (const action of ['approve', 'reject']) {
        const res = await h.call('POST', `/api/destinations/${own.id}/${action}`, both, {
          reason: 'self decision',
        })
        expect(res.statusCode).toBe(403)
        expect(res.json().error.code).toBe('SELF_APPROVAL')
      }

      // Created by A, proved by B (ANALYST+REVIEWER): B still cannot approve.
      const { token: analyst } = await userWith(['ANALYST'])
      const created = (await createDestination(analyst)).json().destination
      const challenge = (
        await h.call('POST', `/api/destinations/${created.id}/challenges`, both, {})
      ).json().challenge
      const signature = await privateKeyToAccount(DEST_KEY).signMessage({
        message: challenge.message,
      })
      await h.call('POST', `/api/destination-challenges/${challenge.id}/signature`, both, {
        signature,
        method: 'WALLET',
      })
      expect(
        (await h.call('POST', `/api/destinations/${created.id}/approve`, both, {})).json().error
          .code,
      ).toBe('SELF_APPROVAL')

      const { token: independent } = await userWith(['REVIEWER'])
      expect(
        (await h.call('POST', `/api/destinations/${created.id}/approve`, independent, {}))
          .statusCode,
      ).toBe(200)
    })

    it('reject needs a reason; resubmission restarts proof and approval; disable needs APPROVED', async () => {
      h = await createHarness(db)
      const { token: analyst } = await userWith(['ANALYST'])
      const destination = await provenDestination(analyst)
      const { token: reviewer } = await userWith(['REVIEWER'])
      const url = (action: string) => `/api/destinations/${destination.id}/${action}`

      expect((await h.call('POST', url('reject'), reviewer, {})).statusCode).toBe(400)
      expect(
        (await h.call('POST', url('disable'), reviewer, { reason: 'too early' })).statusCode,
      ).toBe(409)
      const rejected = await h.call('POST', url('reject'), reviewer, { reason: 'Unknown wallet' })
      expect(rejected.json().destination).toMatchObject({
        status: 'REJECTED',
        statusReason: 'Unknown wallet',
      })
      expect((await h.call('POST', url('challenges'), analyst, {})).statusCode).toBe(409)

      const resubmitted = await h.call('POST', url('resubmit'), analyst, {})
      expect(resubmitted.json().destination).toMatchObject({
        status: 'PENDING_APPROVAL',
        controlVerifiedAt: null,
        statusReason: null,
      })
      expect(resubmitted.json().destination.approvals).toHaveLength(2)
      expect((await h.call('POST', url('approve'), reviewer, {})).statusCode).toBe(409) // new proof needed

      const challenge = (await h.call('POST', url('challenges'), analyst, {})).json().challenge
      const signature = await privateKeyToAccount(DEST_KEY).signMessage({
        message: challenge.message,
      })
      await h.call('POST', `/api/destination-challenges/${challenge.id}/signature`, analyst, {
        signature,
        method: 'WALLET',
      })
      expect((await h.call('POST', url('approve'), reviewer, {})).statusCode).toBe(200)
      const disabled = await h.call('POST', url('disable'), reviewer, { reason: 'Device lost' })
      expect(disabled.json().destination).toMatchObject({
        status: 'DISABLED',
        statusReason: 'Device lost',
      })
    })
  })

  describe('database guards', () => {
    it('APPROVED without proof, a changed address, or self-decided approvals are impossible', async () => {
      h = await createHarness(db)
      const { user, token } = await userWith(['ANALYST'])
      const destination = (await createDestination(token)).json().destination

      await expect(
        db.destination.update({ where: { id: destination.id }, data: { status: 'APPROVED' } }),
      ).rejects.toThrow(/destinations_approved_requires_proof/)
      await expect(
        db.destination.update({
          where: { id: destination.id },
          data: { address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
        }),
      ).rejects.toThrow(/immutable/)
      await expect(
        db.destination.update({ where: { id: destination.id }, data: { status: 'REJECTED' } }),
      ).rejects.toThrow(/destinations_reason_when_closed/)
      const approval = await db.approval.findFirstOrThrow({
        where: { destinationId: destination.id },
      })
      await expect(
        db.approval.update({
          where: { id: approval.id },
          data: { decidedById: user.id, decision: 'APPROVED' },
        }),
      ).rejects.toThrow(/approvals_decider_not_requester/)
    })
  })
})
