import { AppError, type ErrorCode } from '@da/shared'
import type { ChainClientFactory } from '../../src/chains/clients'
import type { ActivitySummary, FeeData } from '../../src/chains/types'

export interface FakeAccount {
  nonce: number
  native: bigint
  /** Token balances keyed by lower-case contract address. */
  tokens?: Record<string, bigint>
  activity: ActivitySummary
  /** Makes every read for this address fail with this code. */
  failWith?: ErrorCode
}

export const NO_ACTIVITY: ActivitySummary = {
  firstActivityAt: null,
  lastIncomingAt: null,
  lastOutgoingAt: null,
  incomingTxCount: 0,
  outgoingTxCount: 0,
  truncated: false,
}

/** In-memory stand-in for RPC + block explorer, controllable per address. */
export function createFakeChain() {
  const accounts = new Map<string, FakeAccount>()
  let configured = true
  /** When set, only these network ids are 'configured' (isolates tests sharing one DB). */
  let onlyNetworks: Set<string> | null = null
  let servedChainId: number | null = null
  const reads: string[] = []
  let fees: FeeData | Error = {
    baseFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  }
  let tokenGas: bigint | Error = 50_000n

  const account = (address: string): FakeAccount => {
    reads.push(address)
    const found = accounts.get(address.toLowerCase())
    if (found?.failWith) throw new AppError(found.failWith, `simulated ${found.failWith}`)
    return found ?? { nonce: 0, native: 0n, activity: NO_ACTIVITY }
  }

  const factory: ChainClientFactory = (network) => {
    if (!configured || (onlyNetworks && !onlyNetworks.has(network.id))) {
      throw new AppError('INVALID_NETWORK', `RPC is not configured for "${network.name}"`)
    }
    return {
      reader: {
        getChainId: async () => servedChainId ?? network.chainId ?? 0,
        getBlockNumber: async () => 123n,
        getNativeBalance: async (a) => account(a).native,
        getTokenBalance: async (a, contract) => account(a).tokens?.[contract.toLowerCase()] ?? 0n,
        getOutgoingNonce: async (a) => account(a).nonce,
        getFeeData: async () => {
          if (fees instanceof Error) throw fees
          return fees
        },
        estimateTokenTransferGas: async () => {
          if (tokenGas instanceof Error) throw tokenGas
          return tokenGas
        },
      },
      activity: { getActivity: async (a) => account(a).activity },
    }
  }

  return {
    factory,
    reads,
    set(address: string, value: FakeAccount) {
      accounts.set(address.toLowerCase(), value)
    },
    setConfigured(value: boolean) {
      configured = value
    },
    restrictTo(networkIds: string[] | null) {
      onlyNetworks = networkIds ? new Set(networkIds) : null
    },
    serveChainId(id: number | null) {
      servedChainId = id
    },
    /** EIP-1559 inputs served by getFeeData (default: base 10 gwei, tip 1 gwei), or a failure. */
    setFees(value: FeeData | Error) {
      fees = value
    },
    setTokenGas(value: bigint | Error) {
      tokenGas = value
    },
  }
}

export type FakeChain = ReturnType<typeof createFakeChain>
