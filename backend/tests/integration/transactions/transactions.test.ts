import { randomInt, randomUUID } from 'node:crypto'
import { decodeFunctionData, erc20Abi, keccak256, parseTransaction } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
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
    opts: { verified?: boolean; destination?: 'APPROVED' | 'PENDING_APPROVAL'; key?: boolean } = {},
  ) {
    const now = h.now()
    const network = await db.network.create({
      data: {
        name: `tx-${randomUUID().slice(0, 8)}`,
        displayName: 'Tx net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: true,
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
