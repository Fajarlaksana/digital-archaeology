import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { REDACTED } from '@da/shared'
import type { Network } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createAddressRepository } from '../../../src/repositories/address.repository'
import { toDbAmount } from '../../../src/repositories/amount'
import { createAuditLogRepository } from '../../../src/repositories/audit-log.repository'

const testDatabaseUrl = inject('testDatabaseUrl')
const UINT256_MAX = 2n ** 256n - 1n

describe.skipIf(!testDatabaseUrl)('database schema & constraints', () => {
  let db: Database
  let network: Network
  let nativeAssetId: string

  const uniqueAddress = () => `0x${randomUUID().replace(/-/g, '').padEnd(40, '0')}`

  beforeAll(async () => {
    db = createPrismaClient(testDatabaseUrl!)
    network = await db.network.create({
      data: {
        name: `testnet-${randomUUID()}`,
        displayName: 'Test network',
        chainId: Math.floor(Math.random() * 1e9),
        isTestnet: true,
      },
    })
    const native = await db.asset.create({
      data: { networkId: network.id, isNative: true, symbol: 'TST', name: 'Test', decimals: 18 },
    })
    nativeAssetId = native.id
  })

  afterAll(async () => {
    await db?.$disconnect()
  })

  describe('addresses', () => {
    it('rejects a blank owner_reference at the database level', async () => {
      await expect(
        db.address.create({
          data: { networkId: network.id, address: uniqueAddress(), ownerReference: '   ' },
        }),
      ).rejects.toThrow()
    })

    it('rejects a blank owner_reference in the repository', async () => {
      const repo = createAddressRepository(db)
      await expect(
        repo.create({ networkId: network.id, address: uniqueAddress(), ownerReference: '' }),
      ).rejects.toThrow(/ownerReference is required/)
    })

    it('rejects the same address twice on one network', async () => {
      const repo = createAddressRepository(db)
      const address = uniqueAddress()
      await repo.create({ networkId: network.id, address, ownerReference: 'SELF' })
      await expect(
        repo.create({ networkId: network.id, address, ownerReference: 'SELF' }),
      ).rejects.toThrow()
    })

    it('defaults every status dimension to its initial value', async () => {
      const repo = createAddressRepository(db)
      const created = await repo.create({
        networkId: network.id,
        address: uniqueAddress(),
        ownerReference: 'SELF',
      })
      expect(created).toMatchObject({
        activityStatus: 'UNKNOWN',
        balanceStatus: 'UNKNOWN',
        authorizationStatus: 'UNVERIFIED',
        recoveryStatus: 'NONE',
        reviewFlag: false,
      })
    })
  })

  describe('balances (base units)', () => {
    it('round-trips uint256 max exactly through NUMERIC(78,0)', async () => {
      const repo = createAddressRepository(db)
      const address = await repo.create({
        networkId: network.id,
        address: uniqueAddress(),
        ownerReference: 'SELF',
      })
      await repo.upsertBalance(address.id, nativeAssetId, UINT256_MAX)
      expect(await repo.listBalances(address.id)).toEqual([
        { assetId: nativeAssetId, quantity: UINT256_MAX },
      ])

      await repo.upsertBalance(address.id, nativeAssetId, 1n)
      expect((await repo.listBalances(address.id))[0]?.quantity).toBe(1n)
    })

    it('rejects a negative quantity at the database level', async () => {
      const address = await createAddressRepository(db).create({
        networkId: network.id,
        address: uniqueAddress(),
        ownerReference: 'SELF',
      })
      await expect(
        db.balance.create({
          data: { addressId: address.id, assetId: nativeAssetId, quantity: toDbAmount(-1n) },
        }),
      ).rejects.toThrow()
    })
  })

  describe('assets', () => {
    it('allows only one native asset per network', async () => {
      await expect(
        db.asset.create({
          data: { networkId: network.id, isNative: true, symbol: 'X', name: 'X', decimals: 18 },
        }),
      ).rejects.toThrow()
    })

    it('requires a contract address for tokens', async () => {
      await expect(
        db.asset.create({
          data: { networkId: network.id, isNative: false, symbol: 'T', name: 'T', decimals: 6 },
        }),
      ).rejects.toThrow()
    })
  })

  describe('audit_logs (append-only)', () => {
    it('stores metadata with sensitive fields redacted', async () => {
      const entry = await createAuditLogRepository(db).create({
        action: 'TEST_EVENT',
        result: 'SUCCESS',
        metadata: { address: '0xabc', nested: { privateKey: '0xdeadbeef', passphrase: 'p' } },
      })
      expect(entry.metadata).toEqual({
        address: '0xabc',
        nested: { privateKey: REDACTED, passphrase: REDACTED },
      })
    })

    it('blocks UPDATE, DELETE and TRUNCATE', async () => {
      const entry = await createAuditLogRepository(db).create({
        action: 'IMMUTABLE',
        result: 'SUCCESS',
      })

      await expect(
        db.auditLog.update({ where: { id: entry.id }, data: { action: 'TAMPERED' } }),
      ).rejects.toThrow(/append-only/)
      await expect(db.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/)
      await expect(db.auditLog.deleteMany({})).rejects.toThrow(/append-only/)
      await expect(db.$executeRawUnsafe('TRUNCATE audit_logs')).rejects.toThrow(/append-only/)

      const stillThere = await db.auditLog.findUnique({ where: { id: entry.id } })
      expect(stillThere?.action).toBe('IMMUTABLE')
    })
  })

  describe('approvals (maker-checker)', () => {
    it('rejects an approval decided by its own requester', async () => {
      const user = await db.user.create({
        data: { email: `${randomUUID()}@test.local`, name: 'Maker', passwordHash: 'x' },
      })
      const destination = await db.destination.create({
        data: { networkId: network.id, address: uniqueAddress(), label: 'Cold wallet' },
      })
      await expect(
        db.approval.create({
          data: {
            subjectType: 'DESTINATION',
            destinationId: destination.id,
            requestedById: user.id,
            decidedById: user.id,
            decision: 'APPROVED',
          },
        }),
      ).rejects.toThrow()
    })

    it('rejects an approval whose subject does not match subject_type', async () => {
      const user = await db.user.create({
        data: { email: `${randomUUID()}@test.local`, name: 'Maker', passwordHash: 'x' },
      })
      await expect(
        db.approval.create({ data: { subjectType: 'DESTINATION', requestedById: user.id } }),
      ).rejects.toThrow()
    })
  })
})
