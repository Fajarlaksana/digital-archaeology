import type { ActivityStatus, Address } from '../generated/prisma/client'
import type { Database } from '../lib/prisma'
import { fromDbAmount, toDbAmount } from './amount'

export interface NewAddress {
  networkId: string
  /** Already validated and canonicalised by the chain adapter (Phase 4). */
  address: string
  ownerReference: string
  label?: string | null
  createdById?: string | null
}

export interface AddressQuery {
  networkId?: string
  activityStatus?: ActivityStatus
  skip?: number
  take?: number
}

export interface AssetBalance {
  assetId: string
  /** Base units. */
  quantity: bigint
}

export function createAddressRepository(db: Database) {
  return {
    create(input: NewAddress): Promise<Address> {
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

    findByNetworkAndAddress(networkId: string, address: string): Promise<Address | null> {
      return db.address.findUnique({ where: { networkId_address: { networkId, address } } })
    },

    list(query: AddressQuery = {}): Promise<Address[]> {
      return db.address.findMany({
        where: { networkId: query.networkId, activityStatus: query.activityStatus },
        orderBy: { createdAt: 'asc' },
        skip: query.skip,
        take: Math.min(query.take ?? 50, 500),
      })
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
