import type { ChainType } from '../generated/prisma/enums'

export type AddressRejection = 'INVALID_FORMAT' | 'BAD_CHECKSUM' | 'ZERO_ADDRESS'

export type AddressCheck =
  { ok: true; address: string } | { ok: false; reason: AddressRejection; message: string }

/**
 * Everything chain-specific goes through this interface (docs/02 §3).
 * Validation is stateless; reads need a configured endpoint, so they live in ChainReader.
 * Transaction building / verification arrive in Phases 9–11.
 */
export interface ChainAdapter {
  readonly chainType: ChainType
  /** Validates and returns the canonical form to store (EIP-55 checksum for EVM). */
  checkAddress(input: string): AddressCheck
}

/** Read-only access to one network through its RPC node — the source of truth for balances. */
export interface ChainReader {
  getChainId(): Promise<number>
  getBlockNumber(): Promise<bigint>
  /** Base units (wei). */
  getNativeBalance(address: string): Promise<bigint>
  /** Base units of the token. */
  getTokenBalance(address: string, contractAddress: string): Promise<bigint>
  /** Number of transactions ever sent by the address (EVM nonce). */
  getOutgoingNonce(address: string): Promise<number>
}

/** History of an address, from an indexer / block explorer (RPC cannot provide it). */
export interface ActivitySummary {
  firstActivityAt: Date | null
  lastIncomingAt: Date | null
  lastOutgoingAt: Date | null
  incomingTxCount: number
  /** Transactions sent by the address itself (comparable with the nonce). */
  outgoingTxCount: number
  /** True when the history hit the provider's limit — counts are lower bounds. */
  truncated: boolean
}

export interface ActivityProvider {
  getActivity(address: string): Promise<ActivitySummary>
}
