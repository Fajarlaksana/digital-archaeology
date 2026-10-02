import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { getAddress } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Role } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, type Harness } from '../auth/harness'

const testDatabaseUrl = inject('testDatabaseUrl')
const MFA_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'REVIEWER'])
const ETH = 10n ** 18n
const randomAddress = () => getAddress(`0x${randomBytes(20).toString('hex')}`)

describe.skipIf(!testDatabaseUrl)('scanner', () => {
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

  /** Network with ETH + one token, and the given addresses registered. */
  async function setup(addresses: Array<{ address: string; label: string; archived?: boolean }>) {
    const token = randomAddress()
    const network = await db.network.create({
      data: {
        name: `scan-${randomUUID().slice(0, 8)}`,
        displayName: 'Scan net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: true,
        rpcUrlEnv: 'CONFIGURED_RPC_URL',
        assets: {
          create: [
            { isNative: true, symbol: 'ETH', name: 'Ether', decimals: 18 },
            {
              isNative: false,
              symbol: 'USDC',
              name: 'USD Coin',
              decimals: 6,
              contractAddress: token,
            },
          ],
        },
      },
      include: { assets: true },
    })
    const rows = []
    for (const a of addresses) {
      rows.push(
        await db.address.create({
          data: {
            networkId: network.id,
            address: a.address,
            label: a.label,
            ownerReference: 'SELF',
            archivedAt: a.archived ? new Date() : null,
          },
        }),
      )
    }
    return { network, token, rows }
  }

  describe('permissions', () => {
    it.each([
      ['SUPER_ADMIN', 200, 403],
      ['ADMIN', 200, 403],
      ['ANALYST', 200, 202],
      ['REVIEWER', 200, 403],
      ['AUDITOR', 200, 403],
    ] as const)('%s → list %i, start %i', async (role, list, start) => {
      h = await createHarness(db)
      const { token } = await tokenFor(role)
      const { network } = await setup([])
      expect((await h.call('GET', '/api/scans', token)).statusCode).toBe(list)
      expect(
        (await h.call('POST', '/api/scans', token, { networkId: network.id })).statusCode,
      ).toBe(start)
    })
  })

  describe('starting a scan', () => {
    it('refuses to start when RPC / explorer is not configured, with a clear message', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const { network } = await setup([])
      h.chain.setConfigured(false)
      const res = await h.call('POST', '/api/scans', token, { networkId: network.id })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatchObject({ code: 'INVALID_NETWORK' })
      expect(res.json().error.message).toMatch(/not configured/)
    })

    it('allows only one queued/running scan per network', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const { network } = await setup([])
      expect(
        (await h.call('POST', '/api/scans', token, { networkId: network.id })).statusCode,
      ).toBe(202)
      expect(
        (await h.call('POST', '/api/scans', token, { networkId: network.id })).statusCode,
      ).toBe(409)
    })

    it('validates the balance criteria', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const { network } = await setup([])
      const post = (body: object) =>
        h.call('POST', '/api/scans', token, { networkId: network.id, ...body })
      expect((await post({ minimumBalance: '2', maximumBalance: '1' })).statusCode).toBe(400)
      expect((await post({ minimumBalance: '0.' + '1'.repeat(19) })).statusCode).toBe(400) // > 18 decimals
      expect((await post({ minimumBalance: '-1' })).statusCode).toBe(400)
    })

    it('counts only non-archived addresses and queues the scan', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const { network } = await setup([
        { address: randomAddress(), label: 'a' },
        { address: randomAddress(), label: 'b', archived: true },
      ])
      const res = await h.call('POST', '/api/scans', token, {
        networkId: network.id,
        thresholdDays: 365,
      })
      expect(res.json().scan).toMatchObject({
        status: 'QUEUED',
        totalAddresses: 1,
        thresholdDays: 365,
      })
      expect(h.enqueued).toEqual([res.json().scan.id])
    })
  })

  describe('running a scan', () => {
    it('analyses, stores history, updates addresses & balances, and tolerates per-address failures', async () => {
      h = await createHarness(db)
      const { user, token } = await tokenFor('ANALYST')
      const [dormant, active, broken, archived, tokenOnly] = Array.from(
        { length: 5 },
        randomAddress,
      )
      const {
        network,
        token: usdc,
        rows,
      } = await setup([
        { address: dormant!, label: 'dormant' },
        { address: active!, label: 'active' },
        { address: broken!, label: 'broken' },
        { address: archived!, label: 'archived', archived: true },
        { address: tokenOnly!, label: 'token-only' },
      ])
      h.chain.set(dormant!, {
        nonce: 2,
        native: ETH / 2n,
        activity: {
          firstActivityAt: daysAgo(2000),
          lastIncomingAt: daysAgo(3), // spam airdrop: must not revive the wallet
          lastOutgoingAt: daysAgo(1000),
          incomingTxCount: 5,
          outgoingTxCount: 2,
          truncated: false,
        },
      })
      h.chain.set(active!, {
        nonce: 9,
        native: 3n * ETH,
        activity: {
          firstActivityAt: daysAgo(400),
          lastIncomingAt: daysAgo(20),
          lastOutgoingAt: daysAgo(10),
          incomingTxCount: 4,
          outgoingTxCount: 9,
          truncated: false,
        },
      })
      h.chain.set(broken!, {
        nonce: 0,
        native: 0n,
        activity: { ...noActivity() },
        failWith: 'RPC_TIMEOUT',
      })
      h.chain.set(tokenOnly!, {
        nonce: 4, // explorer says 3 → mismatch → review
        native: 0n,
        tokens: { [usdc.toLowerCase()]: 1_500_000n },
        activity: {
          firstActivityAt: daysAgo(900),
          lastIncomingAt: daysAgo(900),
          lastOutgoingAt: daysAgo(800),
          incomingTxCount: 1,
          outgoingTxCount: 3,
          truncated: false,
        },
      })

      const started = await h.call('POST', '/api/scans', token, {
        networkId: network.id,
        minimumBalance: '0.1',
        maximumBalance: '1',
      })
      const scanId = started.json().scan.id
      await h.runQueuedScans()

      // Scan summary
      const scan = (await h.call('GET', `/api/scans/${scanId}`, token)).json().scan
      expect(scan).toMatchObject({
        status: 'COMPLETED',
        totalAddresses: 4,
        processedAddresses: 4,
        totalInactive: 2,
        totalFailed: 1,
        minimumBalance: '0.1',
        maximumBalance: '1',
      })
      expect(h.chain.reads.map((a) => a.toLowerCase())).not.toContain(archived!.toLowerCase())

      // Address state
      const dormantRow = await db.address.findUniqueOrThrow({ where: { id: rows[0]!.id } })
      expect(dormantRow).toMatchObject({
        activityStatus: 'INACTIVE',
        balanceStatus: 'HAS_BALANCE',
        inactiveDays: 1000,
        reviewFlag: false,
      })
      expect(dormantRow.lastActivityAt).toEqual(daysAgo(3))
      expect(dormantRow.lastScannedAt).toEqual(h.now())
      const brokenRow = await db.address.findUniqueOrThrow({ where: { id: rows[2]!.id } })
      expect(brokenRow).toMatchObject({ activityStatus: 'UNKNOWN', lastScannedAt: null })
      const tokenRow = await db.address.findUniqueOrThrow({ where: { id: rows[4]!.id } })
      expect(tokenRow).toMatchObject({
        balanceStatus: 'HAS_BALANCE',
        reviewFlag: true,
        reviewNote: 'NONCE_MISMATCH',
      })

      // Result filters
      const results = (filter: string) =>
        h.call('GET', `/api/scans/${scanId}/results?filter=${filter}`, token).then((r) => r.json())
      expect((await results('all')).total).toBe(4)
      expect(
        (await results('inactive')).items.map((i: { label: string }) => i.label).sort(),
      ).toEqual(['dormant', 'token-only'])
      expect((await results('failed')).items).toMatchObject([
        { label: 'broken', errorCode: 'RPC_TIMEOUT' },
      ])
      expect((await results('review')).items).toMatchObject([{ label: 'token-only' }])
      // Criteria: inactive AND native balance within [0.1, 1] → only the dormant wallet (0.5 ETH).
      const criteria = await results('criteria')
      expect(criteria.items).toMatchObject([
        { label: 'dormant', nativeBalance: '0.5', matchesCriteria: true },
      ])

      // Per-address views
      const balances = (await h.call('GET', `/api/addresses/${rows[0]!.id}/balances`, token)).json()
        .balances
      expect(balances).toMatchObject([
        { symbol: 'ETH', quantity: (ETH / 2n).toString(), formatted: '0.5' },
        { symbol: 'USDC', formatted: '0' },
      ])
      const tokenBalances = (
        await h.call('GET', `/api/addresses/${rows[4]!.id}/balances`, token)
      ).json().balances
      expect(tokenBalances.find((b: { symbol: string }) => b.symbol === 'USDC')).toMatchObject({
        formatted: '1.5',
      })
      const history = (await h.call('GET', `/api/addresses/${rows[0]!.id}/activity`, token)).json()
        .history
      expect(history).toMatchObject([
        { scanId, activityStatus: 'INACTIVE', inactiveDays: 1000, nonce: 2 },
      ])

      // Audit
      const completed = await db.auditLog.findFirst({
        where: { action: 'SCAN_COMPLETED', resourceId: scanId },
      })
      expect(completed).toMatchObject({ userId: user.id, result: 'SUCCESS' })
    })

    it('resumes a scan without re-reading addresses already done', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const [first, second] = [randomAddress(), randomAddress()]
      const { network, rows } = await setup([
        { address: first, label: '1' },
        { address: second, label: '2' },
      ])
      const scanId = (await h.call('POST', '/api/scans', token, { networkId: network.id })).json()
        .scan.id
      // Simulate a crash after the first address was recorded.
      await db.scanResult.create({
        data: {
          scanId,
          addressId: rows[0]!.id,
          activityStatus: 'INACTIVE',
          balanceStatus: 'EMPTY',
        },
      })
      await h.runQueuedScans()
      expect(h.chain.reads.map((a) => a.toLowerCase())).not.toContain(first.toLowerCase())
      expect(await db.scanResult.count({ where: { scanId } })).toBe(2)

      // Re-processing a finished scan is a no-op.
      await h.services.scans.process(scanId)
      expect(await db.scanResult.count({ where: { scanId } })).toBe(2)
    })

    it('marks the scan FAILED when every address fails', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const address = randomAddress()
      const { network } = await setup([{ address, label: 'x' }])
      h.chain.set(address, {
        nonce: 0,
        native: 0n,
        activity: noActivity(),
        failWith: 'RPC_RATE_LIMIT',
      })
      const scanId = (await h.call('POST', '/api/scans', token, { networkId: network.id })).json()
        .scan.id
      await h.runQueuedScans()
      const scan = (await h.call('GET', `/api/scans/${scanId}`, token)).json().scan
      expect(scan).toMatchObject({ status: 'FAILED', totalFailed: 1 })
      expect(scan.errorMessage).toMatch(/RPC_RATE_LIMIT/)
    })

    it('fails cleanly when the RPC configuration disappears before the job runs', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const { network } = await setup([{ address: randomAddress(), label: 'x' }])
      const scanId = (await h.call('POST', '/api/scans', token, { networkId: network.id })).json()
        .scan.id
      h.chain.setConfigured(false)
      await h.runQueuedScans()
      const scan = (await h.call('GET', `/api/scans/${scanId}`, token)).json().scan
      expect(scan).toMatchObject({ status: 'FAILED' })
      expect(scan.errorMessage).toMatch(/not configured/)
    })
  })

  describe('RPC health', () => {
    it('reports ok when every active network answers with the right chain id', async () => {
      h = await createHarness(db)
      await setup([])
      const res = await h.call('GET', '/health/rpc')
      expect(res.statusCode).toBe(200)
      expect(res.json().status).toBe('ok')
    })

    it('reports degraded (503) when an RPC serves a different chain', async () => {
      h = await createHarness(db)
      await setup([])
      h.chain.serveChainId(1)
      const res = await h.call('GET', '/health/rpc')
      expect(res.statusCode).toBe(503)
      expect(res.json().networks[0].error).toMatch(/expected/)
      expect(res.body).not.toMatch(/https?:\/\//)
    })
  })
})

function noActivity() {
  return {
    firstActivityAt: null,
    lastIncomingAt: null,
    lastOutgoingAt: null,
    incomingTxCount: 0,
    outgoingTxCount: 0,
    truncated: false,
  }
}
