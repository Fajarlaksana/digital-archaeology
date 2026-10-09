import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, type Harness } from '../auth/harness'

const testDatabaseUrl = inject('testDatabaseUrl')
const TOKEN = 'm'.repeat(40)

describe.skipIf(!testDatabaseUrl)('monitoring (SA 10)', () => {
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

  const metrics = (authorization?: string) =>
    h.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: authorization ? { authorization } : {},
    })

  it('/metrics is off without a token, and needs the exact bearer token when on', async () => {
    h = await createHarness(db)
    expect((await metrics(`Bearer ${TOKEN}`)).statusCode).toBe(404)
    await h.app.close()

    h = await createHarness(db, { metricsToken: TOKEN })
    expect((await metrics()).statusCode).toBe(401)
    expect((await metrics(`Bearer ${'x'.repeat(40)}`)).statusCode).toBe(401)
    expect((await metrics(TOKEN)).statusCode).toBe(401)
    expect((await metrics(`Bearer ${TOKEN}`)).statusCode).toBe(200)
  })

  it('exposes the SA 10 numbers in Prometheus format, without ids, addresses or emails', async () => {
    h = await createHarness(db, { metricsToken: TOKEN })
    const network = await db.network.create({
      data: {
        name: `mon-${randomUUID().slice(0, 8)}`,
        displayName: 'Monitoring net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: true,
      },
    })
    const address = await db.address.create({
      data: {
        networkId: network.id,
        address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
        ownerReference: 'SELF',
        activityStatus: 'INACTIVE',
        authorizationStatus: 'VERIFIED',
        lastScannedAt: new Date(),
      },
    })
    const user = await h.createUser(['ANALYST'])
    const token = await h.activeSession(user)
    await h.call('GET', `/api/addresses/${address.id}`, token)

    const res = await metrics(`Bearer ${TOKEN}`)
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/)
    const body = res.body
    for (const line of [
      '# TYPE da_scans gauge',
      '# TYPE da_scan_duration_seconds_avg gauge',
      '# TYPE da_addresses gauge',
      '# TYPE da_addresses_verified gauge',
      '# TYPE da_addresses_scanned gauge',
      '# TYPE da_transactions gauge',
      '# TYPE da_rpc_errors_total counter',
      '# TYPE da_http_requests_total counter',
    ]) {
      expect(body).toContain(line)
    }
    expect(body).toMatch(/da_addresses\{activity_status="INACTIVE"\} [1-9]\d*/)
    expect(body).toMatch(/da_addresses_verified [1-9]\d*/)
    expect(body).toContain(
      'da_http_requests_total{method="GET",route="/api/addresses/:id",status="200"} 1',
    )
    expect(body).not.toContain(address.id)
    expect(body).not.toContain(address.address)
    expect(body).not.toContain(user.email)
  })

  it('/health/vault reports reachability only; /health/ready fails when a dependency is down', async () => {
    h = await createHarness(db)
    const vault = await h.app.inject({ method: 'GET', url: '/health/vault' })
    expect(vault.statusCode).toBe(200)
    expect(vault.json()).toEqual({ status: 'ok', initialized: false })
    expect(vault.body).not.toMatch(/unlocked/)

    const ready = await h.app.inject({ method: 'GET', url: '/health/ready' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toEqual({
      status: 'ready',
      checks: { database: 'ok', redis: 'not_configured', signer: 'ok' },
    })

    h.signer.setAvailable(false)
    expect((await h.app.inject({ method: 'GET', url: '/health/vault' })).statusCode).toBe(503)
    const notReady = await h.app.inject({ method: 'GET', url: '/health/ready' })
    expect(notReady.statusCode).toBe(503)
    expect(notReady.json().checks.signer).toBe('unavailable')
  })
})
