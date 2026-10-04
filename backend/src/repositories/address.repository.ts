import type { ActivityStatus, Address, Prisma, RecoveryStatus } from '../generated/prisma/client'
import type { Database } from '../lib/prisma'
import { fromDbAmount, toDbAmount } from './amount'

/** Address with its network and the fiat values of its balances (for the estimated value). */
const ADDRESS_INCLUDE = {
  network: true,
  balances: {
    select: {
      fiatValue: true,
      priceSnapshot: { select: { fiatCurrency: true, pricedAt: true } },
    },
  },
} satisfies Prisma.AddressInclude

export type AddressWithNetwork = Prisma.AddressGetPayload<{ include: typeof ADDRESS_INCLUDE }>

export interface NewAddress {
  networkId: string
  /** Already validated and canonicalised by the chain adapter. */
  address: string
  ownerReference: string
  label?: string | null
  createdById?: string | null
}

export interface AddressQuery {
  networkId?: string
  activityStatus?: ActivityStatus
  recoveryStatus?: RecoveryStatus
  /** Case-insensitive match on address, label or owner reference. */
  search?: string
  includeArchived?: boolean
  onlyArchived?: boolean
  skip?: number
  take?: number
}

export interface AssetBalance {
  assetId: string
  /** Base units. */
  quantity: bigint
}

function whereFor(query: AddressQuery): Prisma.AddressWhereInput {
  const search = query.search?.trim()
  return {
    networkId: query.networkId,
    activityStatus: query.activityStatus,
    recoveryStatus: query.recoveryStatus,
    archivedAt: query.onlyArchived ? { not: null } : query.includeArchived ? undefined : null,
    ...(search
      ? {
          OR: [
            { address: { contains: search, mode: 'insensitive' } },
            { label: { contains: search, mode: 'insensitive' } },
            { ownerReference: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }
}

export function createAddressRepository(db: Database) {
  return {
    // async so validation failures surface as a rejected promise, like DB errors do.
    async create(input: NewAddress): Promise<Address> {
      const ownerReference = input.ownerReference.trim()
      if (!ownerReference) throw new Error('ownerReference is required (CLAUDE.md rule 7)')
      return db.address.create({
        data: {
          networkId: input.networkId,
          address: input.address,
          ownerReference,
          label: input.label ?? null,
          createdById: input.createdById ?? null,
        },
      })
    },

    /** Inserts many already-validated rows; rows that already exist are skipped. Returns count. */
    async createMany(rows: NewAddress[]): Promise<number> {
      if (rows.length === 0) return 0
      const result = await db.address.createMany({
        data: rows.map((row) => ({
          networkId: row.networkId,
          address: row.address,
          ownerReference: row.ownerReference.trim(),
          label: row.label ?? null,
          createdById: row.createdById ?? null,
        })),
        skipDuplicates: true,
      })
      return result.count
    },

    findById(id: string): Promise<AddressWithNetwork | null> {
      return db.address.findUnique({ where: { id }, include: ADDRESS_INCLUDE })
    },

    /** Every inventory entry (any network, archived included) for these canonical addresses. */
    findByAddresses(addresses: string[]): Promise<AddressWithNetwork[]> {
      if (addresses.length === 0) return Promise.resolve([])
      return db.address.findMany({
        where: { address: { in: addresses } },
        include: ADDRESS_INCLUDE,
        orderBy: { createdAt: 'asc' },
      })
    },

    findByNetworkAndAddress(networkId: string, address: string): Promise<Address | null> {
      return db.address.findUnique({ where: { networkId_address: { networkId, address } } })
    },

    /** Which of the given (networkId, address) pairs are already registered (archived included). */
    async existingKeys(pairs: Array<{ networkId: string; address: string }>): Promise<Set<string>> {
      const found = new Set<string>()
      for (let i = 0; i < pairs.length; i += 500) {
        const rows = await db.address.findMany({
          where: {
            OR: pairs.slice(i, i + 500).map(({ networkId, address }) => ({ networkId, address })),
          },
          select: { networkId: true, address: true },
        })
        for (const r of rows) found.add(`${r.networkId}:${r.address}`)
      }
      return found
    },

    async list(query: AddressQuery = {}): Promise<{ items: AddressWithNetwork[]; total: number }> {
      const where = whereFor(query)
      const [items, total] = await db.$transaction([
        db.address.findMany({
          where,
          include: ADDRESS_INCLUDE,
          orderBy: { createdAt: 'desc' },
          skip: query.skip,
          take: Math.min(query.take ?? 50, 500),
        }),
        db.address.count({ where }),
      ])
      return { items, total }
    },

    update(
      id: string,
      data: { label?: string | null; ownerReference?: string; archivedAt?: Date | null },
    ): Promise<AddressWithNetwork> {
      return db.address.update({ where: { id }, data, include: ADDRESS_INCLUDE })
    },

    async upsertBalance(addressId: string, assetId: string, quantity: bigint): Promise<void> {
      await db.balance.upsert({
        where: { addressId_assetId: { addressId, assetId } },
        create: { addressId, assetId, quantity: toDbAmount(quantity) },
        update: { quantity: toDbAmount(quantity) },
      })
    },

    async listBalances(addressId: string): Promise<AssetBalance[]> {
      const rows = await db.balance.findMany({ where: { addressId }, orderBy: { assetId: 'asc' } })
      return rows.map((row) => ({ assetId: row.assetId, quantity: fromDbAmount(row.quantity) }))
    },
  }
}

export type AddressRepository = ReturnType<typeof createAddressRepository>
