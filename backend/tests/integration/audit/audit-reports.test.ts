import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { Prisma, type Role } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { UTF8_BOM } from '../../../src/lib/csv'
import { createAuditLogRepository } from '../../../src/repositories/audit-log.repository'
import { createHarness, type Harness } from '../auth/harness'

const testDatabaseUrl = inject('testDatabaseUrl')
const MFA_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'REVIEWER'])
const ROLES: Role[] = ['SUPER_ADMIN', 'ADMIN', 'ANALYST', 'REVIEWER', 'AUDITOR']

class Rollback extends Error {}

describe.skipIf(!testDatabaseUrl)('audit logs & reports', () => {
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

  async function userWith(role: Role) {
    const user = await h.createUser([role], { mfa: MFA_ROLES.has(role) })
    return { user, token: await h.activeSession(user) }
  }
  const lines = (body: string) =>
    body
      .replace(UTF8_BOM, '')
      .split('\r\n')
      .filter((l) => l !== '')

  /** A network + address with a priced balance, an authorization and a confirmed-like transaction. */
  async function data() {
    const network = await db.network.create({
      data: {
        name: `rep-${randomUUID().slice(0, 8)}`,
        displayName: 'Report net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: true,
        explorerUrl: 'https://sepolia.etherscan.io',
        assets: { create: [{ isNative: true, symbol: 'ETH', name: 'Ether', decimals: 18 }] },
      },
      include: { assets: true },
    })
    const eth = network.assets[0]!
    const snapshot = await db.priceSnapshot.create({
      data: {
        assetId: eth.id,
        fiatCurrency: 'USD',
        price: new Prisma.Decimal('2000'),
        source: 'test',
        pricedAt: new Date(),
      },
    })
    const address = await db.address.create({
      data: {
        networkId: network.id,
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        label: '=HYPERLINK("http://evil")',
        ownerReference: 'SELF',
        balances: {
          create: {
            assetId: eth.id,
            quantity: new Prisma.Decimal('250000000000000000'),
            fiatValue: new Prisma.Decimal('500'),
            priceSnapshotId: snapshot.id,
          },
        },
      },
    })
    const { user: analyst } = await userWith('ANALYST')
    await db.authorization.create({
      data: {
        addressId: address.id,
        type: 'MANDATE',
        reference: 'Surat kuasa 12/2026',
        documentSha256: 'ab'.repeat(32),
        documentName: 'kuasa.pdf',
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
        createdById: analyst.id,
      },
    })
    const destination = await db.destination.create({
      data: {
        networkId: network.id,
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        label: 'Cold',
        createdById: analyst.id,
      },
    })
    const tx = await db.transaction.create({
      data: {
        addressId: address.id,
        networkId: network.id,
        assetId: eth.id,
        destinationId: destination.id,
        amount: new Prisma.Decimal('100000000000000000'),
        networkFee: new Prisma.Decimal('525000000000000'),
        gasLimit: new Prisma.Decimal(21000),
        maxFeePerGas: new Prisma.Decimal('25000000000'),
        maxPriorityFeePerGas: new Prisma.Decimal('1000000000'),
        nonce: 3,
        recipient: destination.address,
        unsignedPayload: { serialized: '0x02' },
        unsignedHash: `0x${'cd'.repeat(32)}`,
        createdById: analyst.id,
      },
    })
    return { network, address, tx }
  }

  describe('access control', () => {
    it.each(ROLES)('%s: audit endpoints only for AUDITOR; reports for every role', async (role) => {
      h = await createHarness(db)
      const { token } = await userWith(role)
      const auditCode = role === 'AUDITOR' ? 200 : 403
      expect((await h.call('GET', '/api/audit-logs', token)).statusCode).toBe(auditCode)
      expect((await h.call('GET', '/api/audit-logs/actions', token)).statusCode).toBe(auditCode)
      expect((await h.call('POST', '/api/audit-logs/verify', token, {})).statusCode).toBe(auditCode)
      expect((await h.call('GET', '/api/reports/audit.csv', token)).statusCode).toBe(auditCode)
      for (const report of ['balances', 'authorizations', 'transactions']) {
        expect((await h.call('GET', `/api/reports/${report}.csv`, token)).statusCode).toBe(200)
      }
    })
  })

  describe('audit log browsing', () => {
    it('filters, paginates newest first, shows the user, and stores metadata redacted', async () => {
      h = await createHarness(db)
      const { user, token } = await userWith('AUDITOR')
      const audit = createAuditLogRepository(db)
      const marker = `TEST_${randomUUID().slice(0, 8)}`
      for (let i = 0; i < 5; i++) {
        await audit.create({
          action: marker,
          result: i % 2 === 0 ? 'SUCCESS' : 'DENIED',
          userId: user.id,
          resourceType: 'test',
          resourceId: String(i),
          metadata: { i, password: 'hunter2', nested: { privateKey: '0xabc' } },
        })
      }
      const page1 = (await h.call('GET', `/api/audit-logs?action=${marker}&limit=2`, token)).json()
      expect(page1.items.map((e: { resourceId: string }) => e.resourceId)).toEqual(['4', '3'])
      expect(page1.items[0].user).toMatchObject({ id: user.id, email: user.email })
      expect(JSON.stringify(page1.items)).not.toMatch(/hunter2|0xabc/)
      const page2 = (
        await h.call(
          'GET',
          `/api/audit-logs?action=${marker}&limit=2&before=${page1.nextBefore}`,
          token,
        )
      ).json()
      expect(page2.items.map((e: { resourceId: string }) => e.resourceId)).toEqual(['2', '1'])

      const denied = (
        await h.call('GET', `/api/audit-logs?action=${marker}&result=DENIED`, token)
      ).json()
      expect(denied.items).toHaveLength(2)
      const future = new Date(Date.now() + 60_000).toISOString()
      expect(
        (await h.call('GET', `/api/audit-logs?action=${marker}&from=${future}`, token)).json()
          .items,
      ).toHaveLength(0)
      expect((await h.call('GET', '/api/audit-logs/actions', token)).json().actions).toContain(
        marker,
      )
      expect((await h.call('GET', '/api/audit-logs?before=abc', token)).statusCode).toBe(400)
    })

    it('exports the audit trail as CSV (formula-safe) and audits the export', async () => {
      h = await createHarness(db)
      const { user, token } = await userWith('AUDITOR')
      const marker = `TEST_${randomUUID().slice(0, 8)}`
      await createAuditLogRepository(db).create({
        action: marker,
        result: 'SUCCESS',
        userId: user.id,
        metadata: { note: '=cmd|calc' },
      })
      const res = await h.call('GET', `/api/reports/audit.csv?action=${marker}`, token)
      expect(res.headers['content-disposition']).toMatch(/audit-\d{4}-\d{2}-\d{2}\.csv/)
      const rows = lines(res.body)
      expect(rows[0]).toBe(
        'status_sequence,status_created_at,status_user_email,status_action,status_result,status_resource_type,status_resource_id,status_ip_address,status_request_id,status_metadata_json,status_hash,status_prev_hash',
      )
      expect(rows[1]).toContain(marker)
      expect(rows[1]).toContain(user.email)
      expect(
        await db.auditLog.count({
          where: { userId: user.id, action: 'REPORT_EXPORTED', resourceId: 'audit' },
        }),
      ).toBe(1)
    })
  })

  describe('hash chain (tamper evidence)', () => {
    it('every new row links to the previous one, also under concurrency; the chain verifies', async () => {
      h = await createHarness(db)
      const { user, token } = await userWith('AUDITOR')
      const audit = createAuditLogRepository(db)
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          audit.create({
            action: 'TEST_CONCURRENT',
            result: 'SUCCESS',
            userId: user.id,
            resourceId: String(i),
          }),
        ),
      )
      const rows = await db.auditLog.findMany({
        orderBy: { sequence: 'asc' },
        select: { sequence: true, hash: true, prevHash: true },
      })
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash)
      expect(rows[0]!.prevHash).toBe('0'.repeat(64))

      const check = (await h.call('POST', '/api/audit-logs/verify', token, {})).json()
      expect(check).toMatchObject({ ok: true, firstBrokenSequence: null, reason: null })
      expect(check.headHash).toMatch(/^[0-9a-f]{64}$/)
      expect(
        await db.auditLog.findFirst({ where: { userId: user.id, action: 'AUDIT_CHAIN_VERIFIED' } }),
      ).toBeTruthy()
    })

    it.each([
      [
        'a modified row',
        'ROW_MODIFIED',
        `UPDATE "audit_logs" SET "metadata" = '{"forged":true}' WHERE "sequence" = $1`,
      ],
      ['a deleted row', 'LINK_BROKEN', `DELETE FROM "audit_logs" WHERE "sequence" = $1`],
    ] as const)(
      'detects %s even when the append-only trigger was bypassed',
      async (_label, reason, sql) => {
        h = await createHarness(db)
        const audit = createAuditLogRepository(db)
        for (let i = 0; i < 3; i++)
          await audit.create({ action: 'TEST_TAMPER', result: 'SUCCESS', resourceId: String(i) })
        const victims = await db.auditLog.findMany({
          where: { action: 'TEST_TAMPER' },
          orderBy: { sequence: 'desc' },
          take: 2,
        })
        const victim = victims[1]! // not the newest: a later row must still link to it
        // Simulate an attacker with owner rights — inside a transaction that is rolled back,
        // so the shared test database keeps an intact chain.
        await expect(
          db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              'ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_no_update_delete"',
            )
            await tx.$executeRawUnsafe(sql, victim.sequence)
            await tx.$executeRawUnsafe(
              'ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_no_update_delete"',
            )
            const check = await createAuditLogRepository(tx as unknown as Database).verifyChain()
            expect(check.ok).toBe(false)
            expect(check.reason).toBe(reason)
            const expected = reason === 'ROW_MODIFIED' ? victim.sequence : victims[0]!.sequence
            expect(check.firstBrokenSequence).toBe(expected.toString())
            throw new Rollback()
          }),
        ).rejects.toBeInstanceOf(Rollback)
        expect((await createAuditLogRepository(db).verifyChain()).ok).toBe(true)
      },
    )

    it('the app user still cannot update or delete audit rows', async () => {
      h = await createHarness(db)
      const row = await createAuditLogRepository(db).create({
        action: 'TEST_IMMUTABLE',
        result: 'SUCCESS',
      })
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "audit_logs" SET "action" = 'X' WHERE "id" = $1::uuid`,
          row.id,
        ),
      ).rejects.toThrow(/append-only/)
    })
  })

  describe('reports (SA 21) keep the kinds of data apart (SA 13)', () => {
    it('balances, authorizations and transactions, filtered by network', async () => {
      h = await createHarness(db)
      const { network, tx } = await data()
      const { user, token } = await userWith('ANALYST')
      const q = `?networkId=${network.id}`

      const balances = lines((await h.call('GET', `/api/reports/balances.csv${q}`, token)).body)
      expect(balances[0]).toContain('chain_balance,chain_balance_base_units')
      expect(balances[0]).toContain('estimate_value,estimate_simulated')
      expect(balances).toHaveLength(2)
      expect(balances[1]).toContain(',ETH,,0.25,250000000000000000,')
      expect(balances[1]).toContain(',USD,500.00000000,true,test,')
      expect(balances[1]).toContain(`"'=HYPERLINK(""http://evil"")"`) // formula neutralised

      const auths = lines((await h.call('GET', `/api/reports/authorizations.csv${q}`, token)).body)
      expect(auths[0]).toContain('auth_type,auth_reference,auth_status')
      expect(auths[1]).toContain(
        `MANDATE,Surat kuasa 12/2026,VERIFIED,kuasa.pdf,${'ab'.repeat(32)}`,
      )

      const txs = lines((await h.call('GET', `/api/reports/transactions.csv${q}`, token)).body)
      expect(txs[0]).toContain('chain_tx_hash,chain_block_number')
      expect(txs[1]).toContain(tx.id)
      expect(txs[1]).toContain(',CREATED,')
      expect(txs[1]).toContain(',0.1,100000000000000000,')

      const exports = await db.auditLog.findMany({
        where: { userId: user.id, action: 'REPORT_EXPORTED' },
        orderBy: { sequence: 'asc' },
      })
      expect(exports.map((e) => e.resourceId)).toEqual([
        'balances',
        'authorizations',
        'transactions',
      ])

      const other = lines(
        (await h.call('GET', `/api/reports/balances.csv?networkId=${randomUUID()}`, token)).body,
      )
      expect(other).toHaveLength(1) // header only
    })
  })
})
