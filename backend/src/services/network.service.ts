import { AppError } from '@da/shared'
import { chainAdapterFor, isSupportedChain } from '../chains'
import type { Asset, ChainType, NetworkStatus } from '../generated/prisma/client'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type { NetworkRepository, NetworkWithAssets } from '../repositories/network.repository'
import { recordAction } from './audit-trail'
import type { AuthContext, RequestMeta } from './auth.service'

export interface PublicAsset {
  id: string
  symbol: string
  name: string
  decimals: number
  isNative: boolean
  contractAddress: string | null
}

export interface PublicNetwork {
  id: string
  name: string
  displayName: string
  chainType: ChainType
  chainId: number | null
  isTestnet: boolean
  rpcUrlEnv: string | null
  /** Whether the env var named by rpcUrlEnv is set on the server. The URL itself is never exposed. */
  rpcConfigured: boolean
  explorerUrl: string | null
  status: NetworkStatus
  assets: PublicAsset[]
}

export function toPublicAsset(asset: Asset): PublicAsset {
  return {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    isNative: asset.isNative,
    contractAddress: asset.contractAddress,
  }
}

export interface NetworkServiceDeps {
  networks: NetworkRepository
  audit: AuditLogRepository
  networkMode: 'testnet' | 'mainnet'
  /** True when the named env var holds a value (injected so tests can control it). */
  isEnvSet: (name: string) => boolean
}

export function createNetworkService({
  networks,
  audit,
  networkMode,
  isEnvSet,
}: NetworkServiceDeps) {
  function toPublic(network: NetworkWithAssets): PublicNetwork {
    return {
      id: network.id,
      name: network.name,
      displayName: network.displayName,
      chainType: network.chainType,
      chainId: network.chainId,
      isTestnet: network.isTestnet,
      rpcUrlEnv: network.rpcUrlEnv,
      rpcConfigured: network.rpcUrlEnv ? isEnvSet(network.rpcUrlEnv) : false,
      explorerUrl: network.explorerUrl,
      status: network.status,
      assets: network.assets.map(toPublicAsset),
    }
  }

  async function getOrThrow(id: string): Promise<NetworkWithAssets> {
    const network = await networks.findById(id)
    if (!network) throw new AppError('NOT_FOUND', 'Network not found', { resourceId: id })
    return network
  }

  return {
    async list(): Promise<PublicNetwork[]> {
      return (await networks.list()).map(toPublic)
    },

    async create(
      actor: AuthContext,
      input: {
        name: string
        displayName: string
        chainType: ChainType
        chainId: number | null
        isTestnet: boolean
        rpcUrlEnv: string | null
        explorerUrl: string | null
        nativeAsset: { symbol: string; name: string; decimals: number }
      },
      meta: RequestMeta,
    ): Promise<PublicNetwork> {
      if (!isSupportedChain(input.chainType)) {
        throw new AppError('INVALID_NETWORK', `Chain type ${input.chainType} is not supported yet`)
      }
      if (input.chainType === 'EVM' && input.chainId === null) {
        throw new AppError('VALIDATION_ERROR', 'EVM networks need a chainId')
      }
      // CLAUDE.md rule 10: mainnet only through explicit configuration.
      if (!input.isTestnet && networkMode !== 'mainnet') {
        throw new AppError('FORBIDDEN', 'Mainnet networks are disabled while NETWORK_MODE=testnet')
      }
      const name = input.name.toLowerCase()
      if (await networks.findByName(name)) {
        throw new AppError('CONFLICT', `A network named "${name}" already exists`)
      }
      if (await networks.findByChain(input.chainType, input.chainId)) {
        throw new AppError('CONFLICT', `A network with chainId ${input.chainId} already exists`)
      }

      const created = await networks.create({ ...input, name })
      await recordAction(audit, actor, meta, {
        action: 'NETWORK_CREATED',
        resourceType: 'network',
        resourceId: created.id,
        metadata: {
          name,
          chainType: input.chainType,
          chainId: input.chainId,
          isTestnet: input.isTestnet,
        },
      })
      return toPublic(created)
    },

    async update(
      actor: AuthContext,
      id: string,
      input: {
        displayName?: string
        rpcUrlEnv?: string | null
        explorerUrl?: string | null
        status?: NetworkStatus
      },
      meta: RequestMeta,
    ): Promise<PublicNetwork> {
      const before = await getOrThrow(id)
      const updated = await networks.update(id, input)
      await recordAction(audit, actor, meta, {
        action: 'NETWORK_UPDATED',
        resourceType: 'network',
        resourceId: id,
        metadata: {
          before: {
            displayName: before.displayName,
            rpcUrlEnv: before.rpcUrlEnv,
            explorerUrl: before.explorerUrl,
            status: before.status,
          },
          after: {
            displayName: updated.displayName,
            rpcUrlEnv: updated.rpcUrlEnv,
            explorerUrl: updated.explorerUrl,
            status: updated.status,
          },
        },
      })
      return toPublic(updated)
    },

    async addToken(
      actor: AuthContext,
      networkId: string,
      input: { contractAddress: string; symbol: string; name: string; decimals: number },
      meta: RequestMeta,
    ): Promise<PublicAsset> {
      const network = await getOrThrow(networkId)
      const check = chainAdapterFor(network.chainType).checkAddress(input.contractAddress)
      if (!check.ok) {
        throw new AppError('INVALID_ADDRESS', `Contract address: ${check.message}`)
      }
      if (await networks.findToken(networkId, check.address)) {
        throw new AppError('CONFLICT', 'This token is already registered on this network')
      }
      const token = await networks.createToken({
        networkId,
        contractAddress: check.address,
        symbol: input.symbol,
        name: input.name,
        decimals: input.decimals,
      })
      await recordAction(audit, actor, meta, {
        action: 'ASSET_CREATED',
        resourceType: 'asset',
        resourceId: token.id,
        metadata: {
          networkId,
          contractAddress: check.address,
          symbol: input.symbol,
          decimals: input.decimals,
        },
      })
      return toPublicAsset(token)
    },
  }
}

export type NetworkService = ReturnType<typeof createNetworkService>
