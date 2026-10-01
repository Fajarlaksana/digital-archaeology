import type { Asset, Network } from '../generated/prisma/client'
import type { Database } from '../lib/prisma'

export function createNetworkRepository(db: Database) {
  return {
    list(): Promise<Network[]> {
      return db.network.findMany({ orderBy: { name: 'asc' } })
    },

    findByName(name: string): Promise<Network | null> {
      return db.network.findUnique({ where: { name } })
    },

    listAssets(networkId: string): Promise<Asset[]> {
      return db.asset.findMany({
        where: { networkId },
        orderBy: [{ isNative: 'desc' }, { symbol: 'asc' }],
      })
    },

    findNativeAsset(networkId: string): Promise<Asset | null> {
      return db.asset.findFirst({ where: { networkId, isNative: true } })
    },
  }
}

export type NetworkRepository = ReturnType<typeof createNetworkRepository>
