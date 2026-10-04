import {
  BaseError,
  createPublicClient,
  erc20Abi,
  http,
  HttpRequestError,
  keccak256,
  TimeoutError,
  TransactionReceiptNotFoundError,
  type Address,
  type Transport,
} from 'viem'
import { AppError, type ErrorCode } from '@da/shared'
import type { ChainReader } from '../types'

const RPC_TIMEOUT_MS = 15_000

/**
 * Maps viem errors to our error codes. The message is deliberately generic:
 * viem messages can contain the RPC URL, which often embeds an API key.
 */
function rpcError(error: unknown, fallback: ErrorCode, what: string): AppError {
  if (error instanceof TimeoutError)
    return new AppError('RPC_TIMEOUT', `RPC timed out while reading ${what}`)
  if (error instanceof HttpRequestError && error.status === 429) {
    return new AppError('RPC_RATE_LIMIT', `RPC rate limit reached while reading ${what}`)
  }
  const walk = (e: unknown): boolean =>
    e instanceof Error && (e instanceof TimeoutError || walk((e as { cause?: unknown }).cause))
  if (walk(error)) return new AppError('RPC_TIMEOUT', `RPC timed out while reading ${what}`)
  return new AppError(fallback, `RPC request failed while reading ${what}`)
}

export interface EvmReaderOptions {
  rpcUrl?: string
  /** Injected in tests (viem `custom` transport); defaults to HTTP with retries. */
  transport?: Transport
}

export function createEvmReader(options: EvmReaderOptions): ChainReader {
  const transport =
    options.transport ??
    http(options.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 3, retryDelay: 500 })
  const client = createPublicClient({ transport })

  async function call<T>(what: string, fallback: ErrorCode, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      throw rpcError(error, fallback, what)
    }
  }

  return {
    getChainId: () => call('chain id', 'RPC_TIMEOUT', () => client.getChainId()),
    getBlockNumber: () => call('block number', 'RPC_TIMEOUT', () => client.getBlockNumber()),
    getNativeBalance: (address) =>
      call('native balance', 'BALANCE_READ_FAILED', () =>
        client.getBalance({ address: address as Address }),
      ),
    getTokenBalance: (address, contractAddress) =>
      call('token balance', 'BALANCE_READ_FAILED', () =>
        client.readContract({
          address: contractAddress as Address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address as Address],
        }),
      ),
    getOutgoingNonce: (address) =>
      call('nonce', 'ACTIVITY_READ_FAILED', () =>
        client.getTransactionCount({ address: address as Address, blockTag: 'latest' }),
      ),
    getFeeData: () =>
      call('fee data', 'FEE_ESTIMATION_FAILED', async () => {
        const [block, maxPriorityFeePerGas] = await Promise.all([
          client.getBlock({ blockTag: 'latest' }),
          client.estimateMaxPriorityFeePerGas(),
        ])
        if (block.baseFeePerGas === null) throw new Error('Network does not support EIP-1559')
        return { baseFeePerGas: block.baseFeePerGas, maxPriorityFeePerGas }
      }),
    sendRawTransaction: async (signed) => {
      try {
        return await client.sendRawTransaction({ serializedTransaction: signed as `0x${string}` })
      } catch (error) {
        // Classify by the node's message, but never echo it (it may quote the RPC URL).
        const text = [
          error instanceof BaseError ? error.details : '',
          String((error as Error)?.message ?? ''),
        ]
          .join(' ')
          .toLowerCase()
        if (text.includes('already known') || text.includes('known transaction')) {
          return keccak256(signed as `0x${string}`)
        }
        if (text.includes('nonce too low')) {
          throw new AppError(
            'TRANSACTION_FAILED',
            'The node rejected the transaction: nonce too low',
          )
        }
        if (text.includes('insufficient funds')) {
          throw new AppError(
            'INSUFFICIENT_BALANCE',
            'The node rejected the transaction: insufficient funds',
          )
        }
        if (text.includes('underpriced') || text.includes('fee cap')) {
          throw new AppError('TRANSACTION_FAILED', 'The node rejected the transaction: fee too low')
        }
        throw rpcError(error, 'TRANSACTION_FAILED', 'broadcast')
      }
    },
    getTransactionReceipt: async (hash) => {
      try {
        const r = await client.getTransactionReceipt({ hash: hash as `0x${string}` })
        return {
          status: r.status,
          blockNumber: r.blockNumber,
          gasUsed: r.gasUsed,
          effectiveGasPrice: r.effectiveGasPrice,
        }
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null
        throw rpcError(error, 'RPC_TIMEOUT', 'transaction receipt')
      }
    },
    estimateTokenTransferGas: ({ from, token, to, amount }) =>
      call('token transfer gas', 'FEE_ESTIMATION_FAILED', () =>
        client.estimateContractGas({
          address: token as Address,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [to as Address, amount],
          account: from as Address,
        }),
      ),
  }
}
