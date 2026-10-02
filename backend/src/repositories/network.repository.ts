import type { Asset, ChainType, Network, NetworkStatus } from '../generated/prisma/client'
import type { Database } from '../lib/prisma'

export type NetworkWithAssets = Network & { assets: Asset[] }

export interface NewNetwork {
  name: string
  displayName: string
  chainType: ChainType
  chainId: number | null
  isTestnet: boolean
  rpcUrlEnv: string | null
  explorerUrl: string | null
  nativeAsset: { symbol: string; name: string; decimals: number }
}

export interface NewToken {
  networkId: string
  contractAddress: string
  symbol: string
  name: string
  decimals: number
}

const assetOrder = [{ isNative: 'desc' as const }, { symbol: 'asc' as const }]

export function createNetworkRepository(db: Database) {
  return {
    list(): Promise<NetworkWithAssets[]> {
      return db.network.findMany({
        include: { assets: { orderBy: assetOrder } },
        orderBy: { name: 'asc' },
      })
    },

    findById(id: string): Promise<NetworkWithAssets | null> {
      return db.network.findUnique({ where: { id }, include: { assets: { orderBy: assetOrder } } })
    },

    findByName(name: string): Promise<Network | null> {
      return db.network.findUnique({ where: { name } })
    },

    findByChain(chainType: ChainType, chainId: number | null): Promise<Network | null> {
      return db.network.findFirst({ where: { chainType, chainId } })
    },

    /** Creates the network together with its native asset, atomically. */
    create(input: NewNetwork): Promise<NetworkWithAssets> {
      const { nativeAsset, ...network } = input
      return db.network.create({
        data: { ...network, assets: { create: [{ ...nativeAsset, isNative: true }] } },
        include: { assets: { orderBy: assetOrder } },
      })
    },

    update(
      id: string,
      data: {
        displayName?: string
        rpcUrlEnv?: string | null
        explorerUrl?: string | null
        status?: NetworkStatus
      },
    ): Promise<NetworkWithAssets> {
      return db.network.update({
        where: { id },
        data,
        include: { assets: { orderBy: assetOrder } },
      })
    },

    listAssets(networkId: string): Promise<Asset[]> {
      return db.asset.findMany({ where: { networkId }, orderBy: assetOrder })
    },

    findNativeAsset(networkId: string): Promise<Asset | null> {
      return db.asset.findFirst({ where: { networkId, isNative: true } })
    },

    findToken(networkId: string, contractAddress: string): Promise<Asset | null> {
      return db.asset.findUnique({
        where: { networkId_contractAddress: { networkId, contractAddress } },
      })
    },

    createToken(input: NewToken): Promise<Asset> {
      return db.asset.create({ data: { ...input, isNative: false } })
    },
  }
}

export type NetworkRepository = ReturnType<typeof createNetworkRepository>
