import { randomInt, randomUUID } from 'node:crypto'
import {
  decodeFunctionData,
  erc20Abi,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { AppError } from '@da/shared'
import { Prisma, type Role } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, PASSWORD, type Harness } from '../auth/harness'
import { NO_ACTIVITY } from '../fake-chain'

/* PUBLIC TEST VECTORS (Hardhat / Anvil accounts #0 and #1) — published for testing, never real funds. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const DEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const testDatabaseUrl = inject('testDatabaseUrl')
const MFA_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'REVIEWER'])
const ETH = 10n ** 18n
const GWEI = 10n ** 9n
/** Fake chain fees: base 10 gwei, tip 1 gwei → cap (2×10+1) × 1.2 = 25.2 gwei. */
const CAP = 25_200_000_000n

describe.skipIf(!testDatabaseUrl)('transaction preview & approval', () => {
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

  /** Inventory address with verified ownership, an APPROVED destination and its key in the vault. */
  async function scenario(
    opts: {
      verified?: boolean
      destination?: 'APPROVED' | 'PENDING_APPROVAL'
      key?: boolean
      mainnet?: boolean
    } = {},
  ) {
    const now = h.now()
    const network = await db.network.create({
      data: {
        name: `tx-${randomUUID().slice(0, 8)}`,
        displayName: 'Tx net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: !opts.mainnet,
        assets: {
          create: [
            { isNative: true, symbol: 'ETH', name: 'Ether', decimals: 18 },
            {
              symbol: 'USDC',
              name: 'USD Coin',
              decimals: 6,
              contractAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
            },
          ],
        },
      },
      include: { assets: true },
    })
    const eth = network.assets.find((a) => a.isNative)!
    const usdc = network.assets.find((a) => !a.isNative)!
    await db.priceSnapshot.create({
      data: {
        assetId: eth.id,
        fiatCurrency: 'USD',
        price: new Prisma.Decimal('2000'),
        source: 'test',
        pricedAt: now,
      },
    })
    const address = await db.address.create({
      data: {
        networkId: network.id,
        address: TEST_ADDRESS,
        label: 'Old wallet',
        ownerReference: 'SELF',
      },
    })
    const { user: analyst } = await userWith(['ANALYST'])
    if (opts.verified ?? true) {
      await db.authorization.create({
        data: {
          addressId: address.id,
          type: 'SELF',
          reference: 'Own wallet',
          verificationStatus: 'VERIFIED',
          verifiedAt: now,
          createdById: analyst.id,
        },
      })
    }
    const { user: reviewer } = await userWith(['REVIEWER'])
    const approved = (opts.destination ?? 'APPROVED') === 'APPROVED'
    const destination = await db.destination.create({
      data: {
        networkId: network.id,
        address: DEST_ADDRESS,
        label: 'Cold storage',
        status: opts.destination ?? 'APPROVED',
        controlVerifiedAt: approved ? now : null,
        controlVerifiedById: approved ? analyst.id : null,
        createdById: analyst.id,
        approvals: {
          create: {
            subjectType: 'DESTINATION',
            requestedById: analyst.id,
            decidedById: approved ? reviewer.id : null,
            decision: approved ? 'APPROVED' : null,
            decidedAt: approved ? now : null,
          },
        },
      },
    })
    if (opts.key ?? true) {
      const actor = randomUUID()
      await h.signer.client
        .init({ actor, passphrase: 'p'.repeat(20), recoveryPassphrase: 'r'.repeat(20) })
        .catch(() => undefined)
      await h.signer.client.unlock({ actor, passphrase: 'p'.repeat(20) })
      await h.signer.client
        .importKey({
          actor,
          expectedAddress: TEST_ADDRESS,
          secretType: 'PRIVATE_KEY',
          secret: TEST_KEY,
        })
        .catch(() => undefined)
    }
    h.chain.set(TEST_ADDRESS, {
      nonce: 7,
      native: ETH,
      tokens: { [usdc.contractAddress!.toLowerCase()]: 500_000_000n },
      activity: NO_ACTIVITY,
    })
    return { network, address, destination, eth, usdc }
  }

  async function preview(
    token: string,
    s: { address: { id: string }; destination: { id: string }; eth: { id: string } },
    body: Record<string, unknown> = {},
  ) {
    return h.call('POST', '/api/transactions/preview', token, {
      addressId: s.address.id,
      assetId: s.eth.id,
      destinationId: s.destination.id,
      ...body,
    })
  }

  async function previewed() {
    const { user: creator, token } = await userWith(['ANALYST'])
    const s = await scenario()
    const res = await preview(token, s)
    expect(res.statusCode).toBe(201)
    return { creator, creatorToken: token, s, tx: res.json().transaction }
  }

  describe('access control', () => {
    it.each([
      ['SUPER_ADMIN', { preview: 403, approve: 403 }],
      ['ADMIN', { preview: 403, approve: 403 }],
      ['ANALYST', { preview: 409, approve: 403 }],
      ['REVIEWER', { preview: 403, approve: 200 }],
      ['AUDITOR', { preview: 403, approve: 403 }],
    ] as const)('%s → %j', async (role, expected) => {
      h = await createHarness(db)
      const { s, tx } = await previewed()
      const { token } = await userWith([role])
      expect((await h.call('GET', '/api/transactions', token)).statusCode).toBe(200)
      expect((await h.call('GET', `/api/transactions/${tx.id}`, token)).statusCode).toBe(200)
      // ANALYST is allowed, but the address already has a transaction in flight → 409.
      expect((await preview(token, s)).statusCode).toBe(expected.preview)
      expect(
        (
          await h.call('POST', `/api/transactions/${tx.id}/approve`, token, {
            reason: 'Checked all',
          })
        ).statusCode,
      ).toBe(expected.approve)
    })
  })

  describe('preview', () => {
    it('builds the native sweep from live data and stores exactly what will be signed', async () => {
      h = await createHarness(db)
      const { creator, s, tx } = await previewed()
      const fee = 21_000n * CAP
      expect(tx).toMatchObject({
        status: 'CREATED',
        source: { address: TEST_ADDRESS },
        destination: { address: DEST_ADDRESS },
        asset: { symbol: 'ETH' },
        amount: (ETH - fee).toString(),
        sweep: true,
        nonce: 7,
        gasLimit: '21000',
        maxFeePerGas: CAP.toString(),
        networkFee: fee.toString(),
        networkFeeFormatted: '0.0005292',
        nativeSymbol: 'ETH',
        valueSimulated: true,
        createdBy: { id: creator.id },
      })
      const parsed = parseTransaction(tx.unsignedPayload.serialized)
      expect(parsed).toMatchObject({
        chainId: s.network.chainId,
        nonce: 7,
        value: ETH - fee,
        gas: 21_000n,
        maxFeePerGas: CAP,
      })
      expect(parsed.to?.toLowerCase()).toBe(DEST_ADDRESS.toLowerCase())
      expect(tx.unsignedHash).toBe(keccak256(tx.unsignedPayload.serialized))
      expect(tx.approvals).toEqual([expect.objectContaining({ decision: null })])
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: s.address.id } })).recoveryStatus,
      ).toBe('IN_PROGRESS')
      expect(
        await db.auditLog.count({ where: { userId: creator.id, action: 'TRANSACTION_PREVIEWED' } }),
      ).toBe(1)
    })

    it('token test transfer: smaller amount, transfer() calldata, gas limit with margin', async () => {
      h = await createHarness(db)
      const { token } = await userWith(['ANALYST'])
      const s = await scenario()
      const res = await preview(token, s, { assetId: s.usdc.id, amount: '12.5' })
      expect(res.statusCode).toBe(201)
      const tx = res.json().transaction
      expect(tx).toMatchObject({
        amount: '12500000',
        amountFormatted: '12.5',
        sweep: false,
        gasLimit: '60000',
      })
      const parsed = parseTransaction(tx.unsignedPayload.serialized)
      expect(parsed.to?.toLowerCase()).toBe(s.usdc.contractAddress!.toLowerCase())
      expect(decodeFunctionData({ abi: erc20Abi, data: parsed.data! }).args).toEqual([
        DEST_ADDRESS,
        12_500_000n,
      ])
    })

    it('always uses the latest fee', async () => {
      h = await createHarness(db)
      const { token } = await userWith(['ANALYST'])
      const s = await scenario()
      const first = (await preview(token, s)).json().transaction
      await h.call('POST', `/api/transactions/${first.id}/cancel`, token, { reason: 'fee check' })
      h.chain.setFees({ baseFeePerGas: 20n * GWEI, maxPriorityFeePerGas: 2n * GWEI })
      const second = (await preview(token, s)).json().transaction
      expect(second.maxFeePerGas).toBe((((2n * 20n + 2n) * GWEI * 12n) / 10n).toString())
      expect(second.maxFeePerGas).not.toBe(first.maxFeePerGas)
    })

    it.each([
      ['unverified ownership', { verified: false }, 403, 'AUTHORIZATION_FAILED'],
      ['destination not approved', { destination: 'PENDING_APPROVAL' }, 409, 'CONFLICT'],
      ['key not in the vault', { key: false }, 409, 'CONFLICT'],
    ] as const)('refuses: %s', async (_label, opts, status, code) => {
      h = await createHarness(db)
      const { token } = await userWith(['ANALYST'])
      const s = await scenario(opts)
      const res = await preview(token, s)
      expect(res.statusCode).toBe(status)
      expect(res.json().error.code).toBe(code)
      expect(await db.transaction.count({ where: { addressId: s.address.id } })).toBe(0)
    })

    it('refuses a wrong-chain RPC, too large amounts, missing gas and a second active transaction', async () => {
      h = await createHarness(db)
      const { token } = await userWith(['ANALYST'])
      const s = await scenario()
      h.chain.serveChainId(1)
      expect((await preview(token, s)).json().error.code).toBe('INVALID_NETWORK')
      h.chain.serveChainId(null)
      expect((await preview(token, s, { amount: '1' })).json().error.code).toBe('VALIDATION_ERROR')
      expect((await preview(token, s, { amount: '1.0000000000000000001' })).statusCode).toBe(400)
      h.chain.set(TEST_ADDRESS, {
        nonce: 7,
        native: 0n,
        tokens: { [s.usdc.contractAddress!.toLowerCase()]: 500_000_000n },
        activity: NO_ACTIVITY,
      })
      const noGas = await preview(token, s, { assetId: s.usdc.id })
      expect(noGas.statusCode).toBe(422)
      expect(noGas.json().error.message).toMatch(/NEEDS_GAS_FUNDING/)
      h.chain.set(TEST_ADDRESS, { nonce: 7, native: ETH, activity: NO_ACTIVITY })
      expect((await preview(token, s)).statusCode).toBe(201)
      expect((await preview(token, s)).json().error.message).toMatch(/already has a transaction/)
    })
  })

  describe('approval', () => {
    it('a different REVIEWER approves with a reason after re-authentication; valid for 30 minutes', async () => {
      h = await createHarness(db)
      const { tx } = await previewed()
      const { user: reviewer, token } = await userWith(['REVIEWER'])
      const url = `/api/transactions/${tx.id}/approve`
      expect((await h.call('POST', url, token, {})).statusCode).toBe(400) // reason required

      h.advance(6 * 60_000)
      expect(
        (await h.call('POST', url, token, { reason: 'Matches the plan' })).json().error.code,
      ).toBe('REAUTH_REQUIRED')
      await h.call('POST', '/api/auth/reauth', token, {
        password: PASSWORD,
        code: h.code(reviewer.secret!),
      })
      const res = await h.call('POST', url, token, { reason: 'Matches the plan' })
      expect(res.statusCode).toBe(200)
      const approval = res.json().transaction.approvals[0]
      expect(res.json().transaction.status).toBe('APPROVED')
      expect(approval).toMatchObject({
        decision: 'APPROVED',
        reason: 'Matches the plan',
        decidedBy: { id: reviewer.id },
      })
      expect(new Date(approval.expiresAt).getTime() - new Date(approval.decidedAt).getTime()).toBe(
        30 * 60_000,
      )
      expect(
        await db.auditLog.count({ where: { userId: reviewer.id, action: 'TRANSACTION_APPROVED' } }),
      ).toBe(1)
    })

    it('the creator can never approve or reject, even holding REVIEWER', async () => {
      h = await createHarness(db)
      const { token } = await userWith(['ANALYST', 'REVIEWER'])
      const s = await scenario()
      const tx = (await preview(token, s)).json().transaction
      for (const action of ['approve', 'reject']) {
        const res = await h.call('POST', `/api/transactions/${tx.id}/${action}`, token, {
          reason: 'my own',
        })
        expect(res.statusCode).toBe(403)
        expect(res.json().error.code).toBe('SELF_APPROVAL')
      }
    })

    it.each([
      [
        'NONCE_CHANGED',
        () => h.chain.set(TEST_ADDRESS, { nonce: 8, native: ETH, activity: NO_ACTIVITY }),
      ],
      [
        'FEE_ABOVE_CAP',
        () => h.chain.setFees({ baseFeePerGas: 13n * GWEI, maxPriorityFeePerGas: GWEI }),
      ],
      [
        'BALANCE_INSUFFICIENT',
        () => h.chain.set(TEST_ADDRESS, { nonce: 7, native: ETH / 2n, activity: NO_ACTIVITY }),
      ],
    ] as const)('expires instead of approving when %s', async (reason, change) => {
      h = await createHarness(db)
      const { s, tx } = await previewed()
      const { token } = await userWith(['REVIEWER'])
      change()
      const res = await h.call('POST', `/api/transactions/${tx.id}/approve`, token, {
        reason: 'Looks fine',
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('TRANSACTION_EXPIRED')
      expect(await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).toMatchObject({
        status: 'EXPIRED',
        statusReason: reason,
      })
      // The address is free again for a new preview / evaluation.
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: s.address.id } })).recoveryStatus,
      ).toBe('NONE')
    })

    it('expires when the destination was disabled meanwhile', async () => {
      h = await createHarness(db)
      const { s, tx } = await previewed()
      await db.destination.update({
        where: { id: s.destination.id },
        data: { status: 'DISABLED', statusReason: 'Device lost' },
      })
      const { token } = await userWith(['REVIEWER'])
      await h.call('POST', `/api/transactions/${tx.id}/approve`, token, { reason: 'Looks fine' })
      expect((await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).statusReason).toBe(
        'DESTINATION_NOT_APPROVED',
      )
    })

    it('an approval lapses after 30 minutes', async () => {
      h = await createHarness(db)
      const { tx } = await previewed()
      const { token } = await userWith(['REVIEWER'])
      await h.call('POST', `/api/transactions/${tx.id}/approve`, token, { reason: 'Looks fine' })
      h.advance(31 * 60_000)
      const { token: auditor } = await userWith(['AUDITOR'])
      const res = await h.call('GET', `/api/transactions/${tx.id}`, auditor)
      expect(res.json().transaction).toMatchObject({
        status: 'EXPIRED',
        statusReason: 'APPROVAL_TIMEOUT',
      })
    })

    it('reject (reason required) and cancel close the transaction and free the address', async () => {
      h = await createHarness(db)
      const { s, tx, creatorToken } = await previewed()
      const { token } = await userWith(['REVIEWER'])
      const rejected = await h.call('POST', `/api/transactions/${tx.id}/reject`, token, {
        reason: 'Wrong asset',
      })
      expect(rejected.json().transaction).toMatchObject({
        status: 'REJECTED',
        statusReason: 'Wrong asset',
      })
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: s.address.id } })).recoveryStatus,
      ).toBe('NONE')

      const again = (await preview(creatorToken, s)).json().transaction
      const cancelled = await h.call('POST', `/api/transactions/${again.id}/cancel`, creatorToken, {
        reason: 'Do a test transfer first',
      })
      expect(cancelled.json().transaction.status).toBe('CANCELLED')
      expect(
        (
          await h.call('POST', `/api/transactions/${again.id}/cancel`, creatorToken, {
            reason: 'twice',
          })
        ).statusCode,
      ).toBe(409)
    })
  })

  describe('signing (Phase 10)', () => {
    /** Preview by ANALYST, approval by REVIEWER, and a third person holding SUPER_ADMIN. */
    async function approved() {
      const { creator, creatorToken, s, tx } = await previewed()
      const { user: reviewer, token: reviewerToken } = await userWith(['REVIEWER'])
      const res = await h.call('POST', `/api/transactions/${tx.id}/approve`, reviewerToken, {
        reason: 'Checked',
      })
      expect(res.statusCode).toBe(200)
      const { user: superAdmin, token } = await userWith(['SUPER_ADMIN'])
      return { creator, creatorToken, reviewer, reviewerToken, superAdmin, token, s, tx }
    }
    const sign = (id: string, token: string, body: object = {}) =>
      h.call('POST', `/api/transactions/${id}/sign`, token, body)

    it.each(['ADMIN', 'ANALYST', 'REVIEWER', 'AUDITOR'] as const)('%s → sign 403', async (role) => {
      h = await createHarness(db)
      const { tx } = await approved()
      const { token } = await userWith([role])
      expect((await sign(tx.id, token)).statusCode).toBe(403)
      expect(h.signer.calls).not.toContain('signTransaction')
    })

    it('signs exactly the approved transaction; the raw tx never appears in responses, audit or logs', async () => {
      h = await createHarness(db)
      const { superAdmin, token, tx } = await approved()
      // A payload in the body is ignored: only the id counts.
      const res = await sign(tx.id, token, {
        serialized: '0x02deadbeef',
        to: '0x0000000000000000000000000000000000000001',
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().transaction.status).toBe('SIGNED')

      const stored = await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })
      const raw = stored.signedPayload!
      expect(stored.txHash).toBe(keccak256(raw as `0x${string}`))
      expect(res.json().transaction.txHash).toBe(stored.txHash)
      expect(
        await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` }),
      ).toBe(TEST_ADDRESS)
      const signed = parseTransaction(raw as `0x${string}`)
      const unsigned = parseTransaction(tx.unsignedPayload.serialized)
      for (const f of ['chainId', 'nonce', 'to', 'value', 'gas', 'maxFeePerGas'] as const) {
        expect(signed[f]).toEqual(unsigned[f])
      }

      expect(JSON.stringify(res.json())).not.toContain(raw.slice(4))
      const audits = JSON.stringify(
        await db.auditLog.findMany({ where: { userId: superAdmin.id } }),
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      )
      expect(audits).toContain('TX_SIGNED')
      expect(audits).not.toContain(raw.slice(4))
      expect(audits).not.toContain(TEST_KEY.slice(2))
      expect(h.logs()).not.toContain(raw.slice(4))
    })

    it('refuses a transaction that is not APPROVED, without asking the signer', async () => {
      h = await createHarness(db)
      const { tx } = await previewed()
      const { token } = await userWith(['SUPER_ADMIN'])
      expect((await sign(tx.id, token)).statusCode).toBe(409)
      expect(h.signer.calls).not.toContain('signTransaction')
    })

    it('three different people: the creator or the approver cannot sign, even holding SUPER_ADMIN', async () => {
      h = await createHarness(db)
      const { token: makerSigner } = await userWith(['ANALYST', 'SUPER_ADMIN'])
      const s = await scenario()
      const tx = (await preview(makerSigner, s)).json().transaction
      const { token: checkerSigner } = await userWith(['REVIEWER', 'SUPER_ADMIN'])
      expect(
        (
          await h.call('POST', `/api/transactions/${tx.id}/approve`, checkerSigner, {
            reason: 'Checked',
          })
        ).statusCode,
      ).toBe(200)
      for (const token of [makerSigner, checkerSigner]) {
        const res = await sign(tx.id, token)
        expect(res.statusCode).toBe(403)
        expect(res.json().error.code).toBe('SELF_APPROVAL')
      }
      expect(h.signer.calls).not.toContain('signTransaction')
      const { token: third } = await userWith(['SUPER_ADMIN'])
      expect((await sign(tx.id, third)).statusCode).toBe(200)
    })

    it('expires instead of signing when the chain moved, or the approval window passed', async () => {
      h = await createHarness(db)
      const { tx, token } = await approved()
      h.chain.set(TEST_ADDRESS, { nonce: 8, native: ETH, activity: NO_ACTIVITY })
      const res = await sign(tx.id, token)
      expect(res.json().error.code).toBe('TRANSACTION_EXPIRED')
      expect((await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).statusReason).toBe(
        'NONCE_CHANGED',
      )
      expect(h.signer.calls).not.toContain('signTransaction')

      h = await createHarness(db)
      const again = await approved()
      h.advance(31 * 60_000)
      const { token: fresh } = await userWith(['SUPER_ADMIN'])
      expect((await sign(again.tx.id, fresh)).statusCode).toBe(409)
      expect(
        (await db.transaction.findUniqueOrThrow({ where: { id: again.tx.id } })).statusReason,
      ).toBe('APPROVAL_TIMEOUT')
    })

    it('needs the vault unlocked and a recent re-authentication', async () => {
      h = await createHarness(db)
      const { tx, token, superAdmin } = await approved()
      await h.signer.client.lock({ actor: randomUUID() })
      const locked = await sign(tx.id, token)
      expect(locked.statusCode).toBe(423)
      expect(locked.json().error.code).toBe('VAULT_LOCKED')
      expect((await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe(
        'APPROVED',
      )

      h.advance(6 * 60_000)
      expect((await sign(tx.id, token)).json().error.code).toBe('REAUTH_REQUIRED')
      await h.call('POST', '/api/auth/reauth', token, {
        password: PASSWORD,
        code: h.code(superAdmin.secret!),
      })
    })

    it('Signed Tx Verifier: a signature over different data is discarded and audited', async () => {
      h = await createHarness(db)
      const { tx, token, superAdmin } = await approved()
      h.signer.setTamper((t) => ({ ...t, value: (t.value ?? 0n) + 1n }))
      const res = await sign(tx.id, token)
      expect(res.statusCode).toBe(502)
      expect(res.json().error.code).toBe('TRANSACTION_FAILED')
      const stored = await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })
      expect(stored).toMatchObject({ status: 'APPROVED', signedPayload: null, txHash: null })
      const rejected = await db.auditLog.findFirst({
        where: { userId: superAdmin.id, action: 'TX_SIGNATURE_REJECTED' },
      })
      expect(rejected?.metadata).toMatchObject({ reason: 'FIELD_value' })
    })

    it('the stored signature is immutable', async () => {
      h = await createHarness(db)
      const { tx, token } = await approved()
      await sign(tx.id, token)
      await expect(
        db.transaction.update({ where: { id: tx.id }, data: { signedPayload: '0x02ab' } }),
      ).rejects.toThrow(/immutable/)
    })
  })

  describe('broadcast & confirmation (Phase 11)', () => {
    /** Preview → approve → sign by three different people; returns the SIGNED transaction. */
    async function signed() {
      const { creatorToken, s, tx } = await previewed()
      // The DB is shared by the whole run: only this test's network is reachable on this chain,
      // so checkInFlight never touches transactions left by other tests.
      h.chain.restrictTo([s.network.id])
      const { token: reviewerToken } = await userWith(['REVIEWER'])
      await h.call('POST', `/api/transactions/${tx.id}/approve`, reviewerToken, {
        reason: 'Checked',
      })
      const { user: superAdmin, token } = await userWith(['SUPER_ADMIN'])
      const res = await h.call('POST', `/api/transactions/${tx.id}/sign`, token, {})
      expect(res.statusCode).toBe(200)
      return { creatorToken, s, tx: res.json().transaction, superAdmin, token }
    }
    const broadcast = (id: string, token: string) =>
      h.call('POST', `/api/transactions/${id}/broadcast`, token, {})
    const receipt = (blockNumber: bigint, status: 'success' | 'reverted' = 'success') => ({
      status,
      blockNumber,
      gasUsed: 21_000n,
      effectiveGasPrice: 12n * GWEI,
    })

    it.each(['ADMIN', 'ANALYST', 'REVIEWER', 'AUDITOR'] as const)(
      '%s → broadcast 403',
      async (role) => {
        h = await createHarness(db)
        const { tx } = await signed()
        const { token } = await userWith([role])
        expect((await broadcast(tx.id, token)).statusCode).toBe(403)
        expect(h.chain.sent).toEqual([])
      },
    )

    it('sends exactly the signed raw transaction once, and refuses anything not SIGNED', async () => {
      h = await createHarness(db)
      const { tx, token, superAdmin } = await signed()
      const res = await broadcast(tx.id, token)
      expect(res.statusCode).toBe(200)
      expect(res.json().transaction).toMatchObject({ status: 'BROADCASTED', txHash: tx.txHash })
      const stored = await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })
      expect(h.chain.sent).toEqual([stored.signedPayload])
      expect(stored.broadcastAt).not.toBeNull()
      expect(
        await db.auditLog.count({ where: { userId: superAdmin.id, action: 'TX_BROADCASTED' } }),
      ).toBe(1)
      expect((await broadcast(tx.id, token)).statusCode).toBe(409) // already broadcast
      expect(h.chain.sent).toHaveLength(1)

      h.chain.restrictTo(null)
      const { tx: created } = await previewed()
      expect((await broadcast(created.id, token)).statusCode).toBe(409)
    })

    it('expires instead of sending when the nonce moved since signing', async () => {
      h = await createHarness(db)
      const { tx, token } = await signed()
      h.chain.set(TEST_ADDRESS, { nonce: 8, native: ETH, activity: NO_ACTIVITY })
      const res = await broadcast(tx.id, token)
      expect(res.json().error.code).toBe('TRANSACTION_EXPIRED')
      expect(h.chain.sent).toEqual([])
      expect(await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).toMatchObject({
        status: 'EXPIRED',
        statusReason: 'NONCE_CHANGED',
      })
    })

    it('a node rejection keeps the transaction SIGNED and is audited', async () => {
      h = await createHarness(db)
      const { tx, token, superAdmin } = await signed()
      h.chain.setSendFailure(
        new AppError('TRANSACTION_FAILED', 'The node rejected the transaction: fee too low'),
      )
      const res = await broadcast(tx.id, token)
      expect(res.statusCode).toBe(502)
      expect((await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe(
        'SIGNED',
      )
      expect(
        await db.auditLog.count({
          where: { userId: superAdmin.id, action: 'TX_BROADCAST_FAILED' },
        }),
      ).toBe(1)
    })

    it('PENDING → CONFIRMED after 3 blocks; the address becomes TRANSFERRED with fresh balances', async () => {
      h = await createHarness(db)
      const { tx, token, s } = await signed()
      await db.network.update({
        where: { id: s.network.id },
        data: { explorerUrl: 'https://sepolia.etherscan.io/' },
      })
      await broadcast(tx.id, token)
      h.chain.setReceipt(tx.txHash, receipt(200n))
      h.chain.setBlockNumber(201n)
      await h.services.transactions.checkInFlight()
      expect(await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).toMatchObject({
        status: 'PENDING',
        confirmations: 2,
      })

      // The sweep went through: only dust is left on the source address.
      h.chain.set(TEST_ADDRESS, { nonce: 8, native: 1234n, activity: NO_ACTIVITY })
      h.chain.setBlockNumber(202n)
      const summary = await h.services.transactions.checkInFlight()
      expect(summary).toMatchObject({ confirmed: 1, failed: 0, stuck: 0 })
      const stored = await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })
      expect(stored).toMatchObject({ status: 'CONFIRMED', confirmations: 3, blockNumber: 200n })
      expect(stored.feePaid?.toFixed()).toBe((21_000n * 12n * GWEI).toString())
      expect(stored.confirmedAt).not.toBeNull()
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: s.address.id } })).recoveryStatus,
      ).toBe('TRANSFERRED')
      const balance = await db.balance.findFirstOrThrow({
        where: { addressId: s.address.id, assetId: s.eth.id },
      })
      expect(balance.quantity.toFixed()).toBe('1234')
      expect(
        await db.auditLog.count({ where: { resourceId: tx.id, action: 'TX_CONFIRMED' } }),
      ).toBe(1)

      const { token: auditor } = await userWith(['AUDITOR'])
      const pub = (await h.call('GET', `/api/transactions/${tx.id}`, auditor)).json().transaction
      expect(pub).toMatchObject({
        status: 'CONFIRMED',
        confirmations: 3,
        requiredConfirmations: 3,
        blockNumber: '200',
        feePaidFormatted: '0.000252',
        explorerTxUrl: `https://sepolia.etherscan.io/tx/${tx.txHash}`,
      })
      expect(JSON.stringify(pub)).not.toContain('"signedPayload"')
    })

    it('FAILED when reverted or replaced; the address is free again', async () => {
      h = await createHarness(db)
      const first = await signed()
      await broadcast(first.tx.id, first.token)
      h.chain.setReceipt(first.tx.txHash, receipt(300n, 'reverted'))
      h.chain.setBlockNumber(300n)
      await h.services.transactions.checkInFlight()
      expect(await db.transaction.findUniqueOrThrow({ where: { id: first.tx.id } })).toMatchObject({
        status: 'FAILED',
        failureReason: 'REVERTED',
        statusReason: 'REVERTED',
      })
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: first.s.address.id } })).recoveryStatus,
      ).toBe('NONE')

      h = await createHarness(db)
      const second = await signed()
      await broadcast(second.tx.id, second.token)
      h.chain.set(TEST_ADDRESS, { nonce: 8, native: ETH, activity: NO_ACTIVITY })
      await h.services.transactions.checkInFlight()
      expect(
        (await db.transaction.findUniqueOrThrow({ where: { id: second.tx.id } })).failureReason,
      ).toBe('REPLACED_OR_DROPPED')
    })

    it('flags STUCK after 30 minutes without a receipt (audited once), without failing it', async () => {
      h = await createHarness(db)
      const { tx, token } = await signed()
      await broadcast(tx.id, token)
      h.advance(31 * 60_000)
      await h.services.transactions.checkInFlight()
      await h.services.transactions.checkInFlight()
      const stored = await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })
      expect(stored.status).toBe('BROADCASTED')
      expect(stored.stuckSince).not.toBeNull()
      expect(await db.auditLog.count({ where: { resourceId: tx.id, action: 'TX_STUCK' } })).toBe(1)
      const { token: auditor } = await userWith(['AUDITOR'])
      expect(
        (await h.call('GET', `/api/transactions/${tx.id}`, auditor)).json().transaction.stuck,
      ).toBe(true)
    })

    it('database guards: no BROADCASTED without a time, no CONFIRMED without a block', async () => {
      h = await createHarness(db)
      const { tx } = await signed()
      await expect(
        db.transaction.update({ where: { id: tx.id }, data: { status: 'BROADCASTED' } }),
      ).rejects.toThrow(/transactions_broadcast_recorded/)
      await db.transaction.update({
        where: { id: tx.id },
        data: { status: 'BROADCASTED', broadcastAt: new Date() },
      })
      await expect(
        db.transaction.update({
          where: { id: tx.id },
          data: { status: 'CONFIRMED', confirmations: 3 },
        }),
      ).rejects.toThrow(/transactions_confirmed_recorded/)
    })
  })

  describe('mainnet first transfer (Phase 14, ADR-028)', () => {
    it('the first transfer to a destination must be a small test transfer; afterwards a sweep is allowed', async () => {
      h = await createHarness(db, { networkMode: 'mainnet' })
      const { token } = await userWith(['ANALYST'])
      const s = await scenario({ mainnet: true })
      h.chain.restrictTo([s.network.id])

      const sweep = await preview(token, s)
      expect(sweep.statusCode).toBe(400)
      expect(sweep.json().error.message).toMatch(/must be a small test transfer, not a sweep/)
      // 0.1 ETH = $200 > $25 cap
      expect((await preview(token, s, { amount: '0.1' })).json().error.message).toMatch(
        /at most 25 USD/,
      )
      // 0.01 ETH = $20 ≤ $25
      const test = await preview(token, s, { amount: '0.01' })
      expect(test.statusCode).toBe(201)
      expect(test.json().transaction.sweep).toBe(false)
      await h.call('POST', `/api/transactions/${test.json().transaction.id}/cancel`, token, {
        reason: 'pretend it was confirmed',
      })

      // Once one transfer to the destination is CONFIRMED, sweeps are allowed.
      const confirmed = await db.transaction.findUniqueOrThrow({
        where: { id: test.json().transaction.id },
      })
      await db.transaction.create({
        data: {
          addressId: confirmed.addressId,
          networkId: confirmed.networkId,
          assetId: confirmed.assetId,
          destinationId: confirmed.destinationId,
          amount: confirmed.amount,
          networkFee: confirmed.networkFee,
          gasLimit: confirmed.gasLimit,
          maxFeePerGas: confirmed.maxFeePerGas,
          maxPriorityFeePerGas: confirmed.maxPriorityFeePerGas,
          nonce: confirmed.nonce,
          recipient: confirmed.recipient,
          sweep: false,
          unsignedPayload: confirmed.unsignedPayload as object,
          unsignedHash: confirmed.unsignedHash,
          signedPayload: '0x02',
          txHash: `0x${'9'.repeat(64)}`,
          status: 'CONFIRMED',
          broadcastAt: h.now(),
          confirmedAt: h.now(),
          blockNumber: 10n,
          confirmations: 3,
          createdById: confirmed.createdById,
        },
      })
      expect((await preview(token, s)).statusCode).toBe(201)
    })

    it('refuses the first mainnet transfer when the asset has no price', async () => {
      h = await createHarness(db, { networkMode: 'mainnet' })
      const { token } = await userWith(['ANALYST'])
      const s = await scenario({ mainnet: true })
      h.chain.restrictTo([s.network.id])
      await db.priceSnapshot.deleteMany({ where: { assetId: s.eth.id } })
      expect((await preview(token, s, { amount: '0.001' })).json().error.message).toMatch(
        /price is needed/,
      )
    })

    it('testnet is not restricted', async () => {
      h = await createHarness(db)
      const { token } = await userWith(['ANALYST'])
      const s = await scenario()
      expect((await preview(token, s)).statusCode).toBe(201)
    })
  })

  describe('database guards', () => {
    it('previewed fields are immutable, APPROVED needs an independent approval, status only moves forward', async () => {
      h = await createHarness(db)
      const { tx } = await previewed()
      await expect(
        db.transaction.update({ where: { id: tx.id }, data: { amount: new Prisma.Decimal(1) } }),
      ).rejects.toThrow(/immutable/)
      await expect(
        db.transaction.update({
          where: { id: tx.id },
          data: { recipient: '0x0000000000000000000000000000000000000001' },
        }),
      ).rejects.toThrow(/immutable/)
      await expect(
        db.transaction.update({ where: { id: tx.id }, data: { status: 'APPROVED' } }),
      ).rejects.toThrow(/someone other than the creator/)
      await expect(
        db.transaction.update({ where: { id: tx.id }, data: { status: 'SIGNED' } }),
      ).rejects.toThrow(/not allowed/)
      await db.transaction.update({
        where: { id: tx.id },
        data: { status: 'CANCELLED', statusReason: 'test' },
      })
      await expect(
        db.transaction.update({ where: { id: tx.id }, data: { status: 'CREATED' } }),
      ).rejects.toThrow(/not allowed/)
    })
  })
})
