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
  /**
   * True only when `signature` is a signature of `message` by `address` (EVM: EIP-191
   * personal_sign, EOA only). Never throws: malformed input is simply not valid.
   */
  verifyMessage(input: { address: string; message: string; signature: string }): Promise<boolean>
  /**
   * Builds the unsigned transfer exactly as it will be signed (Phase 9). Pure: every value
   * (nonce, fees, gas) is passed in. `hash` is what the key signs; `payload` is canonical JSON.
   */
  buildUnsignedTransfer(input: UnsignedTransferInput): UnsignedTransfer
  /**
   * Signed Tx Verifier (Phase 10, second line of defence): the signed transaction must be exactly
   * the approved unsigned one (every field) and be signed by `from`.
   */
  verifySignedTransfer(input: {
    signed: string
    unsignedSerialized: string
    from: string
  }): Promise<{ ok: true; txHash: string } | { ok: false; reason: string }>
}

export interface UnsignedTransferInput {
  chainId: number
  nonce: number
  /** Final recipient (the approved destination). */
  recipient: string
  asset: { isNative: boolean; contractAddress: string | null }
  /** Base units of the asset. */
  amount: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export interface UnsignedTransfer {
  /** Canonical, JSON-safe description (bigints as decimal strings) incl. the serialized tx. */
  payload: Record<string, string | number>
  /** 0x-prefixed lower-case hash the key must sign. */
  hash: string
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
  /** Current EIP-1559 fee inputs (wei per gas). Recalculated before every use (docs/02 §2.6). */
  getFeeData(): Promise<FeeData>
  /** Gas needed for `from` to send `amount` of an ERC-20 token to `to`. */
  estimateTokenTransferGas(input: {
    from: string
    token: string
    to: string
    amount: bigint
  }): Promise<bigint>
}

export interface FeeData {
  baseFeePerGas: bigint
  maxPriorityFeePerGas: bigint
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
