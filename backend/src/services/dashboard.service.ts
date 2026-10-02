import { displayFiat } from '../domain/valuation'
import type { Prisma } from '../generated/prisma/client'
import type { Database } from '../lib/prisma'

export interface ScheduleInfo {
  scansEnabled: boolean
  scanPattern: string | null
  timezone: string
  nextScanAt: string | null
  priceIntervalMinutes: number
}

const PENDING_TX = ['CREATED', 'APPROVED', 'SIGNED', 'BROADCASTED', 'PENDING'] as const

/** Read-only aggregates for the dashboard (SA 4.1 / 14). */
export function createDashboardService(deps: {
  db: Database
  fiatCurrency: string
  scheduleInfo: () => Promise<ScheduleInfo | null>
}) {
  const { db, fiatCurrency } = deps

  async function sumFiat(where: Prisma.BalanceWhereInput): Promise<string> {
    const result = await db.balance.aggregate({
      where: { ...where, fiatValue: { not: null }, priceSnapshot: { fiatCurrency } },
      _sum: { fiatValue: true },
    })
    return result._sum.fiatValue?.toFixed(8) ?? '0.00000000'
  }

  async function valueBlock(addressWhere: Prisma.AddressWhereInput) {
    const [real, simulated, oldest] = await Promise.all([
      sumFiat({ address: addressWhere, asset: { network: { isTestnet: false } } }),
      sumFiat({ address: addressWhere, asset: { network: { isTestnet: true } } }),
      db.balance.findFirst({
        where: { address: addressWhere, fiatValue: { not: null }, priceSnapshot: { fiatCurrency } },
        orderBy: { priceSnapshot: { pricedAt: 'asc' } },
        select: { priceSnapshot: { select: { pricedAt: true, source: true } } },
      }),
    ])
    return {
      /** Mainnet value — real money. */
      value: displayFiat(real),
      /** Testnet assets priced as their mainnet counterpart: NOT real money (ADR-016). */
      simulatedValue: displayFiat(simulated),
      oldestPriceAt: oldest?.priceSnapshot?.pricedAt.toISOString() ?? null,
      priceSource: oldest?.priceSnapshot?.source ?? null,
    }
  }

  return {
    /** Whole inventory, or one network when `networkId` is given. */
    async summary(networkId?: string) {
      const live: Prisma.AddressWhereInput = {
        archivedAt: null,
        ...(networkId ? { networkId } : {}),
      }
      const txWhere: Prisma.TransactionWhereInput = networkId ? { networkId } : {}
      const [byActivity, withBalance, verified, review, pending, completed, networks, recent] =
        await Promise.all([
          db.address.groupBy({ by: ['activityStatus'], where: live, _count: { _all: true } }),
          db.address.count({ where: { ...live, balanceStatus: 'HAS_BALANCE' } }),
          db.address.count({ where: { ...live, authorizationStatus: 'VERIFIED' } }),
          db.address.count({ where: { ...live, reviewFlag: true } }),
          db.transaction.count({ where: { ...txWhere, status: { in: [...PENDING_TX] } } }),
          db.transaction.count({ where: { ...txWhere, status: 'CONFIRMED' } }),
          db.network.findMany({
            where: { status: 'ACTIVE', ...(networkId ? { id: networkId } : {}) },
            orderBy: { name: 'asc' },
            include: { scans: { orderBy: { createdAt: 'desc' }, take: 1 } },
          }),
          db.scan.findMany({
            where: networkId ? { networkId } : {},
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: { network: { select: { displayName: true } } },
          }),
        ])
      const count = (status: string) =>
        byActivity.find((g) => g.activityStatus === status)?._count._all ?? 0

      return {
        fiatCurrency,
        networkId: networkId ?? null,
        addresses: {
          total: byActivity.reduce((n, g) => n + g._count._all, 0),
          active: count('ACTIVE'),
          inactive: count('INACTIVE'),
          unscanned: count('UNKNOWN'),
          withBalance,
          verified,
          needsReview: review,
        },
        /** Estimated value held by INACTIVE addresses (the "recoverable value" card). */
        inactiveValue: await valueBlock({ ...live, activityStatus: 'INACTIVE' }),
        totalValue: await valueBlock(live),
        transactions: { pending, completed },
        networks: networks.map((n) => ({
          id: n.id,
          name: n.name,
          displayName: n.displayName,
          isTestnet: n.isTestnet,
          lastScan: n.scans[0]
            ? {
                id: n.scans[0].id,
                status: n.scans[0].status,
                trigger: n.scans[0].trigger,
                createdAt: n.scans[0].createdAt.toISOString(),
                completedAt: n.scans[0].completedAt?.toISOString() ?? null,
              }
            : null,
        })),
        recentScans: recent.map((s) => ({
          id: s.id,
          network: s.network.displayName,
          status: s.status,
          trigger: s.trigger,
          totalAddresses: s.totalAddresses,
          totalInactive: s.totalInactive,
          createdAt: s.createdAt.toISOString(),
        })),
        schedule: await deps.scheduleInfo(),
      }
    },
  }
}

export type DashboardService = ReturnType<typeof createDashboardService>
