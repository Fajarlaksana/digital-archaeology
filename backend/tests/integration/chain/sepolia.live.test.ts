import { randomBytes } from 'node:crypto'
import { getAddress } from 'viem'
import { beforeAll, describe, expect, it } from 'vitest'
import { createEtherscanProvider } from '../../../src/chains/evm/etherscan'
import { createEvmReader } from '../../../src/chains/evm/evm-reader'
import { loadEnvFile } from '../../../src/config/env'
import { createThrottle } from '../../../src/lib/throttle'
import type { ActivityProvider, ChainReader } from '../../../src/chains/types'

/**
 * Talks to the REAL Sepolia RPC and Etherscan API. Skipped unless SEPOLIA_RPC_URL and
 * EXPLORER_API_KEY are set in .env. Read-only: nothing is ever sent to the chain.
 */
loadEnvFile()
const rpcUrl = process.env.SEPOLIA_RPC_URL
const apiKey = process.env.EXPLORER_API_KEY
const SEPOLIA_CHAIN_ID = 11155111
/** Circle's USDC on Sepolia (also in the seed). */
const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'

describe.skipIf(!rpcUrl || !apiKey)('Sepolia (live, read-only)', () => {
  // Built in beforeAll: describe bodies run even when the suite is skipped.
  let reader: ChainReader
  let explorer: ActivityProvider
  beforeAll(() => {
    reader = createEvmReader({ rpcUrl })
    explorer = createEtherscanProvider({
      apiKey: apiKey ?? '',
      chainId: SEPOLIA_CHAIN_ID,
      throttle: createThrottle(2),
    })
  })

  it('RPC serves Sepolia and a recent block', async () => {
    expect(await reader.getChainId()).toBe(SEPOLIA_CHAIN_ID)
    expect(await reader.getBlockNumber()).toBeGreaterThan(1_000_000n)
  }, 30_000)

  it('reads native and ERC-20 balances (USDC contract decimals = 6 path)', async () => {
    expect(await reader.getNativeBalance(SEPOLIA_USDC)).toBeGreaterThanOrEqual(0n)
    expect(await reader.getTokenBalance(SEPOLIA_USDC, SEPOLIA_USDC)).toBeGreaterThanOrEqual(0n)
  }, 30_000)

  it('reads EIP-1559 fee data (Phase 8b)', async () => {
    const fees = await reader.getFeeData()
    expect(fees.baseFeePerGas).toBeGreaterThan(0n)
    expect(fees.maxPriorityFeePerGas).toBeGreaterThanOrEqual(0n)
  })

  it('explorer key works: a fresh random address has no history', async () => {
    const fresh = getAddress(`0x${randomBytes(20).toString('hex')}`)
    expect(await explorer.getActivity(fresh)).toEqual({
      firstActivityAt: null,
      lastIncomingAt: null,
      lastOutgoingAt: null,
      incomingTxCount: 0,
      outgoingTxCount: 0,
      truncated: false,
    })
    expect(await reader.getOutgoingNonce(fresh)).toBe(0)
  }, 60_000)
})
