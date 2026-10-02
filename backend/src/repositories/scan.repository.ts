import type {
  ActivityStatus,
  Address,
  BalanceStatus,
  Network,
  Prisma,
  Scan,
  ScanResult,
  ScanStatus,
} from '../generated/prisma/client'
import type { Database } from '../lib/prisma'
import { fromDbAmountOrNull, toDbAmount } from './amount'

export type ScanWithNetwork = Scan & { network: Network; _count: { results: number } }
export type ScanResultWithAddress = ScanResult & { address: Address }

/** Stored in scan_results.balances: quantities as base-unit STRINGS (JSON has no bigint). */
export interface StoredBalance {
  assetId: string
  symbol: string
  quantity: string
}

export interface ScanOutcome {
  activityStatus: ActivityStatus
  balanceStatus: BalanceStatus
  lastActivityAt: Date | null
  lastIncomingAt: Date | null
  lastOutgoingAt: Date | null
  inactiveDays: number | null
  incomingTxCount: number
  outgoingTxCount: number
  nonce: number
  reviewReasons: string[]
  balances: Array<{ assetId: string; symbol: string; quantity: bigint }>
}

export type ResultFilter = 'all' | 'inactive' | 'review' | 'failed'

const withNetwork = { network: true, _count: { select: { results: true } } } as const

function resultWhere(scanId: string, filter: ResultFilter): Prisma.ScanResultWhereInput {
  switch (filter) {
    case 'inactive':
      return { scanId, activityStatus: 'INACTIVE', errorCode: null }
    case 'review':
      return { scanId, reviewFlag: true }
    case 'failed':
      return { scanId, errorCode: { not: null } }
    default:
      return { scanId }
  }
}

export function createScanRepository(db: Database) {
  return {
    create(data: {
      networkId: string
      thresholdDays: number
      minimumBalance: bigint | null
      maximumBalance: bigint | null
      totalAddresses: number
      createdById: string
    }): Promise<Scan> {
      return db.scan.create({
        data: {
          ...data,
          minimumBalance: data.minimumBalance === null ? null : toDbAmount(data.minimumBalance),
          maximumBalance: data.maximumBalance === null ? null : toDbAmount(data.maximumBalance),
        },
      })
    },

    findById(id: string): Promise<ScanWithNetwork | null> {
      return db.scan.findUnique({ where: { id }, include: withNetwork })
    },

    findActiveForNetwork(networkId: string): Promise<Scan | null> {
      return db.scan.findFirst({ where: { networkId, status: { in: ['QUEUED', 'RUNNING'] } } })
    },

    async list(skip: number, take: number): Promise<{ items: ScanWithNetwork[]; total: number }> {
      const [items, total] = await db.$transaction([
        db.scan.findMany({ include: withNetwork, orderBy: { createdAt: 'desc' }, skip, take }),
        db.scan.count(),
      ])
      return { items, total }
    },

    async setStatus(
      id: string,
      status: ScanStatus,
      extra: { startedAt?: Date; completedAt?: Date; errorMessage?: string | null } = {},
    ): Promise<void> {
      await db.scan.update({ where: { id }, data: { status, ...extra } })
    },

    /** Non-archived addresses of the network — archived ones are never scanned (ADR-014). */
    listTargets(networkId: string): Promise<Array<{ id: string; address: string }>> {
      return db.address.findMany({
        where: { networkId, archivedAt: null },
        select: { id: true, address: true },
        orderBy: { createdAt: 'asc' },
      })
    },

    async doneAddressIds(scanId: string): Promise<Set<string>> {
      const rows = await db.scanResult.findMany({ where: { scanId }, select: { addressId: true } })
      return new Set(rows.map((r) => r.addressId))
    },

    /** Stores one successful result and updates the address' latest state, atomically. */
    async recordSuccess(
      scanId: string,
      addressId: string,
      outcome: ScanOutcome,
      scannedAt: Date,
    ): Promise<void> {
      const stored: StoredBalance[] = outcome.balances.map((b) => ({
        assetId: b.assetId,
        symbol: b.symbol,
        quantity: b.quantity.toString(),
      }))
      const reviewFlag = outcome.reviewReasons.length > 0
      await db.$transaction([
        db.scanResult.create({
          data: {
            scanId,
            addressId,
            activityStatus: outcome.activityStatus,
            balanceStatus: outcome.balanceStatus,
            lastActivityAt: outcome.lastActivityAt,
            lastIncomingAt: outcome.lastIncomingAt,
            lastOutgoingAt: outcome.lastOutgoingAt,
            inactiveDays: outcome.inactiveDays,
            incomingTxCount: outcome.incomingTxCount,
            outgoingTxCount: outcome.outgoingTxCount,
            nonce: outcome.nonce,
            reviewFlag,
            balances: stored as unknown as Prisma.InputJsonValue,
          },
        }),
        db.address.update({
          where: { id: addressId },
          data: {
            activityStatus: outcome.activityStatus,
            balanceStatus: outcome.balanceStatus,
            lastActivityAt: outcome.lastActivityAt,
            lastIncomingAt: outcome.lastIncomingAt,
            lastOutgoingAt: outcome.lastOutgoingAt,
            inactiveDays: outcome.inactiveDays,
            lastScannedAt: scannedAt,
            reviewFlag,
            reviewNote: reviewFlag ? outcome.reviewReasons.join(', ') : null,
          },
        }),
        ...outcome.balances.map((b) =>
          db.balance.upsert({
            where: { addressId_assetId: { addressId, assetId: b.assetId } },
            create: { addressId, assetId: b.assetId, quantity: toDbAmount(b.quantity) },
            update: { quantity: toDbAmount(b.quantity) },
          }),
        ),
      ])
    },

    /** Records a per-address failure; the address keeps its previous state. */
    async recordFailure(scanId: string, addressId: string, errorCode: string): Promise<void> {
      await db.scanResult.create({
        data: { scanId, addressId, activityStatus: 'UNKNOWN', balanceStatus: 'UNKNOWN', errorCode },
      })
    },

    async totals(scanId: string): Promise<{ done: number; inactive: number; failed: number }> {
      const [done, inactive, failed] = await db.$transaction([
        db.scanResult.count({ where: { scanId } }),
        db.scanResult.count({ where: resultWhere(scanId, 'inactive') }),
        db.scanResult.count({ where: resultWhere(scanId, 'failed') }),
      ])
      return { done, inactive, failed }
    },

    async saveTotals(scanId: string, totals: { inactive: number; failed: number }): Promise<void> {
      await db.scan.update({
        where: { id: scanId },
        data: { totalInactive: totals.inactive, totalFailed: totals.failed },
      })
    },

    async failureCodes(scanId: string): Promise<Array<{ code: string; count: number }>> {
      const rows = await db.scanResult.groupBy({
        by: ['errorCode'],
        where: resultWhere(scanId, 'failed'),
        _count: { _all: true },
      })
      return rows
        .map((r) => ({ code: r.errorCode ?? 'UNKNOWN', count: r._count._all }))
        .sort((a, b) => b.count - a.count)
    },

    async results(
      scanId: string,
      filter: ResultFilter,
      skip: number,
      take: number,
    ): Promise<{ items: ScanResultWithAddress[]; total: number }> {
      const where = resultWhere(scanId, filter)
      const [items, total] = await db.$transaction([
        db.scanResult.findMany({
          where,
          include: { address: true },
          orderBy: { createdAt: 'asc' },
          skip,
          take,
        }),
        db.scanResult.count({ where }),
      ])
      return { items, total }
    },

    historyForAddress(addressId: string, take: number) {
      return db.scanResult.findMany({
        where: { addressId },
        include: { scan: { select: { id: true, thresholdDays: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
        take,
      })
    },

    async balancesForAddress(addressId: string) {
      const rows = await db.balance.findMany({
        where: { addressId },
        include: { asset: true },
        orderBy: [{ asset: { isNative: 'desc' } }, { asset: { symbol: 'asc' } }],
      })
      return rows.map((row) => ({
        asset: row.asset,
        quantity: fromDbAmountOrNull(row.quantity) ?? 0n,
        updatedAt: row.updatedAt,
      }))
    },
  }
}

export type ScanRepository = ReturnType<typeof createScanRepository>
