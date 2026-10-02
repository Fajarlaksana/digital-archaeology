import { AppError } from '@da/shared'
import type { ChainClientFactory } from '../chains/clients'
import type { NetworkRepository } from '../repositories/network.repository'

export interface RpcHealth {
  status: 'ok' | 'degraded' | 'not_configured'
  networks: Array<{
    name: string
    ok: boolean
    chainId?: number
    blockNumber?: string
    error?: string
  }>
}

/** Checks every active network: RPC reachable, chain id matches, latest block readable. */
export function createChainHealth(deps: {
  networks: NetworkRepository
  clientsFor: ChainClientFactory
}) {
  return async function checkRpc(): Promise<RpcHealth> {
    const active = (await deps.networks.list()).filter((n) => n.status === 'ACTIVE')
    const results: RpcHealth['networks'] = []

    for (const network of active) {
      try {
        const { reader } = deps.clientsFor(network)
        const chainId = await reader.getChainId()
        if (chainId !== network.chainId) {
          results.push({
            name: network.name,
            ok: false,
            chainId,
            error: `RPC serves chain ${chainId}, expected ${network.chainId}`,
          })
          continue
        }
        const blockNumber = await reader.getBlockNumber()
        results.push({ name: network.name, ok: true, chainId, blockNumber: blockNumber.toString() })
      } catch (error) {
        results.push({
          name: network.name,
          ok: false,
          error: error instanceof AppError ? error.message : 'RPC check failed',
        })
      }
    }

    const status =
      results.length === 0 ? 'not_configured' : results.every((r) => r.ok) ? 'ok' : 'degraded'
    return { status, networks: results }
  }
}
