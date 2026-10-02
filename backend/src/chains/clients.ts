import { AppError } from '@da/shared'
import type { Network } from '../generated/prisma/client'
import { createThrottle } from '../lib/throttle'
import { createEtherscanProvider } from './evm/etherscan'
import { createEvmReader } from './evm/evm-reader'
import type { ActivityProvider, ChainReader } from './types'

export interface ChainClients {
  reader: ChainReader
  activity: ActivityProvider
}

/** Builds (and caches) the read clients for a network. Throws INVALID_NETWORK when not configured. */
export type ChainClientFactory = (network: Network) => ChainClients

export interface ChainClientConfig {
  explorerApiKey: string | undefined
  explorerApiUrl: string
  explorerRatePerSecond: number
  /** Reads an env var by name (RPC URLs are referenced by name from networks.rpc_url_env). */
  readEnv: (name: string) => string | undefined
}

export function createChainClientFactory(config: ChainClientConfig): ChainClientFactory {
  // One explorer key is shared by every network, so they share one rate limit too.
  const explorerThrottle = createThrottle(config.explorerRatePerSecond)
  const cache = new Map<string, { rpcUrl: string; clients: ChainClients }>()

  return (network) => {
    if (network.chainType !== 'EVM' || network.chainId === null) {
      throw new AppError(
        'INVALID_NETWORK',
        `Scanning ${network.chainType} networks is not supported yet`,
      )
    }
    const rpcUrl = network.rpcUrlEnv ? config.readEnv(network.rpcUrlEnv) : undefined
    if (!rpcUrl) {
      throw new AppError(
        'INVALID_NETWORK',
        `RPC is not configured for "${network.name}": set ${network.rpcUrlEnv ?? 'an RPC env var'} in the server .env`,
      )
    }
    if (!config.explorerApiKey) {
      throw new AppError('INVALID_NETWORK', 'EXPLORER_API_KEY is not configured in the server .env')
    }

    const cached = cache.get(network.id)
    if (cached && cached.rpcUrl === rpcUrl) return cached.clients

    const clients: ChainClients = {
      reader: createEvmReader({ rpcUrl }),
      activity: createEtherscanProvider({
        apiKey: config.explorerApiKey,
        chainId: network.chainId,
        baseUrl: config.explorerApiUrl,
        throttle: explorerThrottle,
      }),
    }
    cache.set(network.id, { rpcUrl, clients })
    return clients
  }
}
