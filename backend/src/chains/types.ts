import type { ChainType } from '../generated/prisma/enums'

export type AddressRejection = 'INVALID_FORMAT' | 'BAD_CHECKSUM' | 'ZERO_ADDRESS'

export type AddressCheck =
  { ok: true; address: string } | { ok: false; reason: AddressRejection; message: string }

/**
 * Everything chain-specific goes through this interface (docs/02 §3).
 * Phase 4 implements validation only; balance/activity reads arrive in Phase 5,
 * transaction building / verification in Phases 9–11.
 */
export interface ChainAdapter {
  readonly chainType: ChainType
  /** Validates and returns the canonical form to store (EIP-55 checksum for EVM). */
  checkAddress(input: string): AddressCheck
}
