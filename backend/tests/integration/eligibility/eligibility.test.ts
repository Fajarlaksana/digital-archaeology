import { randomInt, randomUUID } from 'node:crypto'
import { Prisma } from '../../../src/generated/prisma/client'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Role } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, type Harness } from '../auth/harness'

/* PUBLIC TEST VECTORS (Hardhat / Anvil accounts #0 and #1) — published for testing, never real funds. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const DEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const testDatabaseUrl = inject('testDatabaseUrl')
const MFA_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'REVIEWER'])
const ETH = 10n ** 18n
const GWEI = 10n ** 9n
const HOUR = 3_600_000

describe.skipIf(!testDatabaseUrl)('recovery eligibility', () => {
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

  /**
   * A network with ETH ($2000) + USDC ($1), one inventory address holding `eth` / `usdc`,
   * and — unless switched off — every precondition for READY.
   */
  async function scenario(
    opts: {
      eth?: bigint
      usdc?: bigint
      authorization?: 'VERIFIED' | 'EXPIRED' | 'NONE'
      destination?: boolean
      key?: boolean
      scannedHoursAgo?: number
      recoveryStatus?: 'IN_PROGRESS'
      archived?: boolean
    } = {},
  ) {
    const now = h.now()
    const network = await db.network.create({
      data: {
        name: `elig-${randomUUID().slice(0, 8)}`,
        displayName: 'Eligibility net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: true,
        assets: {
          create: [
            { isNative: true, symbol: 'ETH', name: 'Ether', decimals: 18 },
            {
              symbol: 'USDC',
              name: 'USD Coin',
              decimals: 6,
              contractAddress: `0x${randomUUID().replaceAll('-', '').slice(0, 32)}00000000`,
            },
          ],
        },
      },
      include: { assets: true },
    })
    const eth = network.assets.find((a) => a.isNative)!
    const usdc = network.assets.find((a) => !a.isNative)!
    for (const [asset, price] of [
      [eth, '2000'],
      [usdc, '1'],
    ] as const) {
      await db.priceSnapshot.create({
        data: {
          assetId: asset.id,
          fiatCurrency: 'USD',
          price: new Prisma.Decimal(price),
          source: 'test',
          pricedAt: now,
        },
      })
    }
    const address = await db.address.create({
      data: {
        networkId: network.id,
        address: TEST_ADDRESS,
        label: 'Old wallet',
        ownerReference: 'SELF',
        lastScannedAt: new Date(now.getTime() - (opts.scannedHoursAgo ?? 1) * HOUR),
        recoveryStatus: opts.recoveryStatus ?? 'NONE',
        archivedAt: opts.archived ? now : null,
        balances: {
          create: [
            { assetId: eth.id, quantity: new Prisma.Decimal((opts.eth ?? ETH / 10n).toString()) },
            {
              assetId: usdc.id,
              quantity: new Prisma.Decimal(((opts.usdc ?? 500n) * 1_000_000n).toString()),
            },
          ],
        },
      },
    })
    const { user: analyst } = await tokenFor('ANALYST')
    if ((opts.authorization ?? 'VERIFIED') !== 'NONE') {
      await db.authorization.create({
        data: {
          addressId: address.id,
          type: 'SELF',
          reference: 'Own wallet',
          verificationStatus: 'VERIFIED',
          verifiedAt: now,
          expiresAt: opts.authorization === 'EXPIRED' ? new Date(now.getTime() - HOUR) : null,
          createdById: analyst.id,
        },
      })
    }
    if (opts.destination ?? true) {
      const { user: reviewer } = await tokenFor('REVIEWER')
      await db.destination.create({
        data: {
          networkId: network.id,
          address: DEST_ADDRESS,
          label: 'Cold storage',
          status: 'APPROVED',
          controlVerifiedAt: now,
          controlVerifiedById: analyst.id,
          createdById: analyst.id,
          approvals: {
            create: {
              subjectType: 'DESTINATION',
              requestedById: analyst.id,
              decidedById: reviewer.id,
              decision: 'APPROVED',
              decidedAt: now,
            },
          },
        },
      })
    }
    if (opts.key ?? true) {
      const actor = randomUUID()
      const signer = h.signer.client
      await signer
        .init({ actor, passphrase: 'p'.repeat(20), recoveryPassphrase: 'r'.repeat(20) })
        .catch(() => undefined)
      await signer.unlock({ actor, passphrase: 'p'.repeat(20) })
      await signer
        .importKey({
          actor,
          expectedAddress: TEST_ADDRESS,
          secretType: 'PRIVATE_KEY',
          secret: TEST_KEY,
        })
        .catch(() => undefined) // already imported in this harness
    }
    return { network, address, eth, usdc }
  }

  async function evaluate(networkId: string) {
    const { token } = await tokenFor('ANALYST')
    const res = await h.call('POST', '/api/eligibility/evaluate', token, { networkId })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  const results = (addressId: string) =>
    db.assetEligibility.findMany({ where: { addressId }, include: { asset: true } })

  describe('access control', () => {
    it.each([
      ['SUPER_ADMIN', 403],
      ['ADMIN', 403],
      ['ANALYST', 200],
      ['REVIEWER', 403],
      ['AUDITOR', 403],
    ] as const)(
      '%s → evaluate %i; everyone may read results and the report',
      async (role, code) => {
        h = await createHarness(db)
        const { network, address } = await scenario()
        const { token } = await tokenFor(role)
        expect(
          (await h.call('POST', '/api/eligibility/evaluate', token, { networkId: network.id }))
            .statusCode,
        ).toBe(code)
        expect(
          (await h.call('GET', `/api/addresses/${address.id}/eligibility`, token)).statusCode,
        ).toBe(200)
        expect((await h.call('GET', '/api/eligibility/config', token)).statusCode).toBe(200)
        expect((await h.call('GET', '/api/reports/eligibility.csv', token)).statusCode).toBe(200)
      },
    )
  })

  describe('evaluation', () => {
    it('READY with fresh fees, stored per asset, summarised on the address and audited', async () => {
      h = await createHarness(db)
      const { network, address } = await scenario()
      const summary = await evaluate(network.id)
      expect(summary).toMatchObject({ evaluated: 1, ready: 1, notEligible: 0, feeError: null })

      const stored = await db.address.findUniqueOrThrow({ where: { id: address.id } })
      expect(stored).toMatchObject({ recoveryStatus: 'READY', recoveryReason: null })
      expect(stored.eligibilityCheckedAt).not.toBeNull()

      const rows = await results(address.id)
      const eth = rows.find((r) => r.asset.symbol === 'ETH')!
      const usdc = rows.find((r) => r.asset.symbol === 'USDC')!
      // Native: 21 000 × (2×10 + 1) gwei × 1.2 = 529 200 gwei
      expect(eth).toMatchObject({ status: 'READY', reason: null, simulated: true })
      expect(eth.feeEstimate?.toFixed()).toBe((529_200n * GWEI).toString())
      // Token: 50 000 gas (fake estimate) × 21 gwei × 1.2 = 1 260 000 gwei = $2.52
      expect(usdc).toMatchObject({ status: 'READY' })
      expect(usdc.feeEstimate?.toFixed()).toBe((1_260_000n * GWEI).toString())
      expect(usdc.netFiat?.toFixed(2)).toBe('497.48')

      const { token } = await tokenFor('AUDITOR')
      const api = (await h.call('GET', `/api/addresses/${address.id}/eligibility`, token)).json()
      expect(api.assets.map((a: { symbol: string }) => a.symbol)).toEqual(['ETH', 'USDC'])
      expect(api.assets[0]).toMatchObject({
        formatted: '0.1',
        fiatCurrency: 'USD',
        simulated: true,
      })

      expect(
        await db.auditLog.count({
          where: { action: 'ELIGIBILITY_EVALUATED', resourceId: network.id },
        }),
      ).toBe(1)
    })

    it.each([
      [{ authorization: 'NONE' }, 'AUTH_NOT_VERIFIED'],
      [{ authorization: 'EXPIRED' }, 'AUTH_EXPIRED'],
      [{ destination: false }, 'NO_APPROVED_DESTINATION'],
      [{ key: false }, 'NO_KEY_IN_VAULT'],
      [{ scannedHoursAgo: 40 }, 'STALE_BALANCE'],
    ] as const)('%j → NOT_ELIGIBLE (%s)', async (opts, reason) => {
      h = await createHarness(db)
      const { network, address } = await scenario(opts)
      await evaluate(network.id)
      expect(await db.address.findUniqueOrThrow({ where: { id: address.id } })).toMatchObject({
        recoveryStatus: 'NOT_ELIGIBLE',
        recoveryReason: reason,
      })
    })

    it('SIGNER_UNAVAILABLE when the vault cannot be asked', async () => {
      h = await createHarness(db)
      const { network, address } = await scenario()
      h.signer.setAvailable(false)
      await evaluate(network.id)
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: address.id } })).recoveryReason,
      ).toBe('SIGNER_UNAVAILABLE')
    })

    it('NEEDS_GAS_FUNDING for a valuable token without native gas', async () => {
      h = await createHarness(db)
      const { network, address } = await scenario({ eth: 0n, usdc: 500n })
      await evaluate(network.id)
      expect(await db.address.findUniqueOrThrow({ where: { id: address.id } })).toMatchObject({
        recoveryStatus: 'NOT_ELIGIBLE',
        recoveryReason: 'NEEDS_GAS_FUNDING',
      })
    })

    it('NOT_ECONOMIC below the $10 minimum', async () => {
      h = await createHarness(db)
      const { network, address } = await scenario({ eth: 10n ** 15n, usdc: 0n }) // 0.001 ETH = $2
      await evaluate(network.id)
      expect(await db.address.findUniqueOrThrow({ where: { id: address.id } })).toMatchObject({
        recoveryStatus: 'NOT_ECONOMIC',
        recoveryReason: 'BELOW_MINIMUM',
      })
    })

    it('FEE_UNAVAILABLE when fee data cannot be read, and the summary says why', async () => {
      h = await createHarness(db)
      const { network, address } = await scenario()
      h.chain.setFees(new Error('rpc down'))
      const summary = await evaluate(network.id)
      expect(summary.feeError).toBe('FEE_ESTIMATION_FAILED')
      const rows = await results(address.id)
      expect(rows.every((r) => r.reason === 'FEE_UNAVAILABLE')).toBe(true)
    })

    it('never touches archived addresses or addresses already in a recovery workflow', async () => {
      h = await createHarness(db)
      const { network, address } = await scenario({ recoveryStatus: 'IN_PROGRESS' })
      const archived = await db.address.create({
        data: {
          networkId: network.id,
          address: DEST_ADDRESS,
          ownerReference: 'SELF',
          archivedAt: h.now(),
        },
      })
      const summary = await evaluate(network.id)
      expect(summary.evaluated).toBe(0)
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: address.id } })).recoveryStatus,
      ).toBe('IN_PROGRESS')
      expect(
        (await db.address.findUniqueOrThrow({ where: { id: archived.id } })).recoveryStatus,
      ).toBe('NONE')
    })

    it('replaces old results on re-evaluation (e.g. after the key was removed from consideration)', async () => {
      h = await createHarness(db)
      const { network, address } = await scenario()
      await evaluate(network.id)
      await db.destination.updateMany({
        where: { networkId: network.id },
        data: { status: 'DISABLED', statusReason: 'Device lost' },
      })
      await evaluate(network.id)
      const rows = await results(address.id)
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.reason === 'NO_APPROVED_DESTINATION')).toBe(true)
    })
  })

  describe('integration with the rest of the system', () => {
    it('runs automatically after a scan completes', async () => {
      h = await createHarness(db)
      const { network, address } = await scenario({ scannedHoursAgo: 100 })
      h.chain.set(TEST_ADDRESS, {
        nonce: 3,
        native: ETH,
        activity: {
          firstActivityAt: new Date('2019-01-01'),
          lastIncomingAt: new Date('2019-02-01'),
          lastOutgoingAt: new Date('2019-03-01'),
          incomingTxCount: 2,
          outgoingTxCount: 3,
          truncated: false,
        },
      })
      const { token } = await tokenFor('ANALYST')
      expect(
        (await h.call('POST', '/api/scans', token, { networkId: network.id })).statusCode,
      ).toBe(202)
      await h.runQueuedScans()
      const stored = await db.address.findUniqueOrThrow({ where: { id: address.id } })
      expect(stored.eligibilityCheckedAt).not.toBeNull()
      expect(stored.recoveryStatus).toBe('READY')
      expect(
        await db.auditLog.findFirst({
          where: { action: 'ELIGIBILITY_EVALUATED', resourceId: network.id },
        }),
      ).toMatchObject({ userId: null })
    })

    it('filters the address list by recovery status and exports the eligibility report', async () => {
      h = await createHarness(db)
      const { network, address } = await scenario()
      await evaluate(network.id)
      const { token } = await tokenFor('AUDITOR')
      const list = await h.call(
        'GET',
        `/api/addresses?networkId=${network.id}&recoveryStatus=READY`,
        token,
      )
      expect(list.json().items.map((a: { id: string }) => a.id)).toEqual([address.id])
      expect(list.json().items[0]).toMatchObject({ recoveryStatus: 'READY', recoveryReasons: [] })
      expect(
        (
          await h.call(
            'GET',
            `/api/addresses?networkId=${network.id}&recoveryStatus=NOT_ECONOMIC`,
            token,
          )
        ).json().total,
      ).toBe(0)

      const csv = await h.call('GET', '/api/reports/eligibility.csv', token)
      expect(csv.headers['content-type']).toMatch(/text\/csv/)
      const lines = csv.body.split('\n')
      expect(lines[0]).toContain('address,network,label,owner_reference')
      expect(lines.some((l: string) => l.includes(TEST_ADDRESS) && l.includes(',USDC,500,'))).toBe(
        true,
      )
    })
  })
})
