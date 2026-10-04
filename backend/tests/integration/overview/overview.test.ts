import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { getAddress } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Role } from '../../../src/generated/prisma/client'
import { UTF8_BOM } from '../../../src/lib/csv'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, type Harness } from '../auth/harness'

const testDatabaseUrl = inject('testDatabaseUrl')
const MFA_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'REVIEWER'])
const ETH = 10n ** 18n
const randomAddress = () => getAddress(`0x${randomBytes(20).toString('hex')}`)

describe.skipIf(!testDatabaseUrl)('valuation, dashboard, reports, scheduler', () => {
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

  const daysAgo = (n: number) => new Date(h.now().getTime() - n * 86_400_000)

  /**
   * A network with ETH (priced via a unique fake id) and USDC, plus addresses.
   * Unique price ids keep this test independent of other files sharing the database.
   */
  async function setup(opts: { isTestnet?: boolean } = {}) {
    const ethId = `eth-${randomUUID().slice(0, 8)}`
    const usdcId = `usdc-${randomUUID().slice(0, 8)}`
    const usdc = randomAddress()
    const network = await db.network.create({
      data: {
        name: `val-${randomUUID().slice(0, 8)}`,
        displayName: 'Valuation net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: opts.isTestnet ?? true,
        rpcUrlEnv: 'CONFIGURED_RPC_URL',
        assets: {
          create: [
            { isNative: true, symbol: 'ETH', name: 'Ether', decimals: 18, priceId: ethId },
            {
              isNative: false,
              symbol: 'USDC',
              name: 'USD Coin',
              decimals: 6,
              contractAddress: usdc,
              priceId: usdcId,
            },
          ],
        },
      },
      include: { assets: true },
    })
    h.chain.restrictTo([network.id])
    const native = network.assets.find((a) => a.isNative)!
    const token = network.assets.find((a) => !a.isNative)!
    return { network, native, token, ethId, usdcId, usdc }
  }

  async function addAddress(networkId: string, label: string) {
    return db.address.create({
      data: { networkId, address: randomAddress(), label, ownerReference: 'SELF' },
    })
  }

  describe('prices & valuation', () => {
    it('refreshes prices, stores snapshots and values every balance exactly', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      const { native, token: usdcAsset, ethId, usdcId } = await setup()
      const wallet = await addAddress(native.networkId, 'w')
      await db.balance.createMany({
        data: [
          { addressId: wallet.id, assetId: native.id, quantity: (ETH / 2n).toString() }, // 0.5 ETH
          { addressId: wallet.id, assetId: usdcAsset.id, quantity: '1500000' }, // 1.5 USDC
        ],
      })
      h.prices.set(ethId, '2500.5')
      h.prices.set(usdcId, '1.0001')

      const res = await h.call('POST', '/api/prices/refresh', token, {})
      expect(res.statusCode).toBe(200)
      expect(res.json().priced).toBeGreaterThanOrEqual(2)

      const balances = await db.balance.findMany({
        where: { addressId: wallet.id },
        include: { asset: true },
      })
      const value = (symbol: string) =>
        balances.find((b) => b.asset.symbol === symbol)?.fiatValue?.toFixed(8)
      expect(value('ETH')).toBe('1250.25000000')
      expect(value('USDC')).toBe('1.50015000')

      const snapshot = await db.priceSnapshot.findFirst({ where: { assetId: native.id } })
      expect(snapshot).toMatchObject({ fiatCurrency: 'USD', source: 'fake-prices' })
      expect(snapshot?.price.toFixed()).toBe('2500.5')

      const audit = await db.auditLog.findFirst({
        where: { action: 'POST /api/prices/refresh', resourceType: 'http' },
        orderBy: { sequence: 'desc' },
      })
      expect(audit?.result).toBe('SUCCESS')
    })

    it('reports assets without a price and leaves their value empty', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      const { native, ethId } = await setup()
      const wallet = await addAddress(native.networkId, 'w')
      await db.balance.create({
        data: { addressId: wallet.id, assetId: native.id, quantity: ETH.toString() },
      })

      const res = await h.call('POST', '/api/prices/refresh', token, {})
      expect(res.json().missing).toContain(ethId)
      const balance = await db.balance.findFirst({ where: { addressId: wallet.id } })
      expect(balance?.fiatValue).toBeNull()
    })

    it('returns PRICE_UNAVAILABLE when the provider is down', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      await setup()
      h.prices.fail(true)
      const res = await h.call('POST', '/api/prices/refresh', token, {})
      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('PRICE_UNAVAILABLE')
    })

    it('lets only ADMIN set an asset price id, validates it, and audits the change', async () => {
      h = await createHarness(db)
      const { user, token } = await tokenFor('ADMIN')
      const { network, native } = await setup()
      const url = `/api/networks/${network.id}/assets/${native.id}`

      expect((await h.call('PATCH', url, token, { priceId: 'Not A Valid Id' })).statusCode).toBe(
        400,
      )
      const ok = await h.call('PATCH', url, token, { priceId: 'ethereum' })
      expect(ok.json().asset).toMatchObject({ priceId: 'ethereum' })
      const audit = await db.auditLog.findFirst({
        where: { userId: user.id, action: 'ASSET_UPDATED' },
      })
      expect(audit?.metadata).toMatchObject({ after: { priceId: 'ethereum' } })

      const { token: analyst } = await tokenFor('ANALYST')
      expect((await h.call('PATCH', url, analyst, { priceId: null })).statusCode).toBe(403)
      expect((await h.call('POST', '/api/prices/refresh', analyst, {})).statusCode).toBe(403)
    })

    it('values new balances right after a scan, marked as simulated on testnet', async () => {
      h = await createHarness(db)
      const { token: admin } = await tokenFor('ADMIN')
      const { token } = await tokenFor('ANALYST')
      const { network, ethId } = await setup({ isTestnet: true })
      const wallet = await addAddress(network.id, 'dormant')
      h.prices.set(ethId, '2000')
      await h.call('POST', '/api/prices/refresh', admin, {}) // snapshot exists before the scan
      h.chain.set(wallet.address, {
        nonce: 1,
        native: 2n * ETH,
        activity: {
          firstActivityAt: daysAgo(1500),
          lastIncomingAt: daysAgo(1500),
          lastOutgoingAt: daysAgo(1000),
          incomingTxCount: 1,
          outgoingTxCount: 1,
          truncated: false,
        },
      })

      await h.call('POST', '/api/scans', token, { networkId: network.id })
      await h.runQueuedScans()

      const detail = (await h.call('GET', `/api/addresses/${wallet.id}`, token)).json().address
      expect(detail).toMatchObject({
        estimatedValue: '4000.00000000',
        fiatCurrency: 'USD',
        valueSimulated: true,
      })
      const balances = (await h.call('GET', `/api/addresses/${wallet.id}/balances`, token)).json()
        .balances
      expect(balances[0]).toMatchObject({
        symbol: 'ETH',
        formatted: '2',
        fiatValue: '4000.00',
        price: '2000',
        priceSource: 'fake-prices',
        simulated: true,
      })
    })
  })

  describe('dashboard', () => {
    it('summarises one network: counts, inactive value split into real vs simulated', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('AUDITOR')
      const { network, native } = await setup({ isTestnet: true })
      const inactive = await addAddress(network.id, 'inactive')
      const active = await addAddress(network.id, 'active')
      await addAddress(network.id, 'unscanned')
      const archived = await addAddress(network.id, 'archived')
      await db.address.update({
        where: { id: inactive.id },
        data: { activityStatus: 'INACTIVE', balanceStatus: 'HAS_BALANCE', reviewFlag: true },
      })
      await db.address.update({
        where: { id: active.id },
        data: { activityStatus: 'ACTIVE', balanceStatus: 'HAS_BALANCE' },
      })
      await db.address.update({
        where: { id: archived.id },
        data: { archivedAt: new Date(), activityStatus: 'INACTIVE' },
      })
      const snapshot = await db.priceSnapshot.create({
        data: {
          assetId: native.id,
          fiatCurrency: 'USD',
          price: '1000',
          source: 'fake-prices',
          pricedAt: daysAgo(1),
        },
      })
      await db.balance.createMany({
        data: [
          {
            addressId: inactive.id,
            assetId: native.id,
            quantity: ETH.toString(),
            fiatValue: '1000',
            priceSnapshotId: snapshot.id,
          },
          {
            addressId: active.id,
            assetId: native.id,
            quantity: (3n * ETH).toString(),
            fiatValue: '3000',
            priceSnapshotId: snapshot.id,
          },
          {
            addressId: archived.id,
            assetId: native.id,
            quantity: ETH.toString(),
            fiatValue: '1000',
            priceSnapshotId: snapshot.id,
          },
        ],
      })

      const res = await h.call('GET', `/api/dashboard?networkId=${network.id}`, token)
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.addresses).toEqual({
        total: 3, // archived excluded
        active: 1,
        inactive: 1,
        unscanned: 1,
        withBalance: 2,
        verified: 0,
        needsReview: 1,
      })
      expect(body.inactiveValue).toMatchObject({
        value: '0.00',
        simulatedValue: '1000.00',
        priceSource: 'fake-prices',
      })
      expect(body.totalValue).toMatchObject({ value: '0.00', simulatedValue: '4000.00' })
      expect(body.transactions).toEqual({ pending: 0, completed: 0 })
      expect(body.networks).toHaveLength(1)
      expect(body.fiatCurrency).toBe('USD')
    })

    it('counts mainnet value as real money', async () => {
      h = await createHarness(db, { networkMode: 'mainnet' })
      const { token } = await tokenFor('ANALYST')
      const { network, native } = await setup({ isTestnet: false })
      const wallet = await addAddress(network.id, 'mainnet wallet')
      await db.address.update({ where: { id: wallet.id }, data: { activityStatus: 'INACTIVE' } })
      const snapshot = await db.priceSnapshot.create({
        data: {
          assetId: native.id,
          fiatCurrency: 'USD',
          price: '1',
          source: 'fake-prices',
          pricedAt: daysAgo(0),
        },
      })
      await db.balance.create({
        data: {
          addressId: wallet.id,
          assetId: native.id,
          quantity: '1',
          fiatValue: '0.00000001',
          priceSnapshotId: snapshot.id,
        },
      })
      const body = (await h.call('GET', `/api/dashboard?networkId=${network.id}`, token)).json()
      expect(body.inactiveValue).toMatchObject({ value: '0.00000001', simulatedValue: '0.00' })
    })

    it('is available to every role and requires login', async () => {
      h = await createHarness(db)
      expect((await h.call('GET', '/api/dashboard')).statusCode).toBe(401)
      for (const role of ['SUPER_ADMIN', 'ADMIN', 'ANALYST', 'REVIEWER', 'AUDITOR'] as const) {
        const { token } = await tokenFor(role)
        expect((await h.call('GET', '/api/dashboard', token)).statusCode, role).toBe(200)
      }
    })
  })

  describe('CSV reports', () => {
    it('exports one row per address × asset, neutralises formulas, and audits the export', async () => {
      h = await createHarness(db)
      const { user, token } = await tokenFor('AUDITOR')
      const { network, native } = await setup()
      const evil = await db.address.create({
        data: {
          networkId: network.id,
          address: randomAddress(),
          label: '=HYPERLINK("http://evil")',
          ownerReference: '+CASE-1',
          activityStatus: 'INACTIVE',
        },
      })
      const snapshot = await db.priceSnapshot.create({
        data: {
          assetId: native.id,
          fiatCurrency: 'USD',
          price: '2000',
          source: 'fake-prices',
          pricedAt: daysAgo(0),
        },
      })
      await db.balance.create({
        data: {
          addressId: evil.id,
          assetId: native.id,
          quantity: (ETH / 4n).toString(),
          fiatValue: '500',
          priceSnapshotId: snapshot.id,
        },
      })
      const plain = await addAddress(network.id, 'never scanned')

      const res = await h.call('GET', '/api/reports/addresses.csv?type=inventory', token)
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')
      expect(res.headers['content-disposition']).toMatch(
        /attachment; filename="addresses-inventory-\d{4}-\d{2}-\d{2}\.csv"/,
      )

      const lines = res.body.replace(UTF8_BOM, '').split('\r\n')
      expect(lines[0]).toContain('address,network,label,owner_reference')
      const evilLine = lines.find((l) => l.startsWith(evil.address))!
      expect(evilLine).toContain(`"'=HYPERLINK(""http://evil"")"`)
      expect(evilLine).toContain("'+CASE-1")
      expect(evilLine).toContain(',ETH,0.25,250000000000000000,USD,500.00000000,true,fake-prices,')
      expect(lines.some((l) => l.startsWith(plain.address))).toBe(true)

      const inactivity = await h.call('GET', '/api/reports/addresses.csv?type=inactivity', token)
      expect(inactivity.body).toContain(evil.address)
      expect(inactivity.body).not.toContain(plain.address)

      // Both exports are audited, in order (sequence, not insertion luck).
      const audits = await db.auditLog.findMany({
        where: { userId: user.id, action: 'REPORT_EXPORTED' },
        orderBy: { sequence: 'asc' },
      })
      expect(audits.map((a) => a.resourceId)).toEqual([
        'addresses-inventory',
        'addresses-inactivity',
      ])
    })

    it('requires reports:read', async () => {
      h = await createHarness(db)
      expect((await h.call('GET', '/api/reports/addresses.csv')).statusCode).toBe(401)
    })
  })

  describe('scheduled scans', () => {
    it('queues a SYSTEM scan per configured network that has addresses and is idle', async () => {
      h = await createHarness(db)
      const { network } = await setup()
      await addAddress(network.id, 'w')

      const first = await h.services.scans.startScheduledScans()
      expect(first.started).toHaveLength(1)
      const scan = await db.scan.findUniqueOrThrow({ where: { id: first.started[0]! } })
      expect(scan).toMatchObject({
        networkId: network.id,
        trigger: 'SCHEDULED',
        createdById: null,
        status: 'QUEUED',
      })
      const audit = await db.auditLog.findFirst({
        where: { action: 'SCAN_SCHEDULED', resourceId: scan.id },
      })
      expect(audit).toMatchObject({ userId: null })

      // Already queued → skipped, not duplicated.
      const second = await h.services.scans.startScheduledScans()
      expect(second.started).toHaveLength(0)
      expect(second.skipped).toContainEqual({
        network: network.name,
        reason: 'a scan is already queued or running',
      })

      await h.runQueuedScans()
      expect((await db.scan.findUniqueOrThrow({ where: { id: scan.id } })).status).toBe('COMPLETED')
    })

    it('skips networks without addresses', async () => {
      h = await createHarness(db)
      const { network } = await setup()
      const result = await h.services.scans.startScheduledScans()
      expect(result.started).toHaveLength(0)
      expect(result.skipped).toContainEqual({ network: network.name, reason: 'no addresses' })
    })
  })
})
