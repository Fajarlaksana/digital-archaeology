import type { TransactionReceipt } from '../chains/types'

/**
 * Tracks a broadcast transaction to its final state (Phase 11, ADR-024). Pure.
 *
 *  - no receipt, nonce still free  → stays BROADCASTED (STUCK after a while — never auto-failed)
 *  - no receipt, nonce used by another transaction → FAILED (REPLACED_OR_DROPPED)
 *  - receipt "reverted"           → FAILED (REVERTED)
 *  - receipt "success"            → PENDING until `required` confirmations, then CONFIRMED
 */
export type TrackedStatus = 'BROADCASTED' | 'PENDING' | 'CONFIRMED' | 'FAILED'

export interface ConfirmationState {
  status: TrackedStatus
  confirmations: number
  failureReason: 'REVERTED' | 'REPLACED_OR_DROPPED' | null
  stuck: boolean
}

export function evaluateConfirmation(input: {
  current: 'BROADCASTED' | 'PENDING'
  receipt: TransactionReceipt | null
  currentBlock: bigint
  required: number
  /** The address's confirmed nonce now (transaction count at `latest`). */
  latestNonce: number
  txNonce: number
  broadcastAt: Date
  now: Date
  stuckAfterMs: number
}): ConfirmationState {
  if (input.receipt) {
    const depth = input.currentBlock - input.receipt.blockNumber + 1n
    const confirmations = depth > 0n ? Number(depth) : 0
    if (input.receipt.status === 'reverted') {
      return { status: 'FAILED', confirmations, failureReason: 'REVERTED', stuck: false }
    }
    return {
      status: confirmations >= input.required ? 'CONFIRMED' : 'PENDING',
      confirmations,
      failureReason: null,
      stuck: false,
    }
  }
  // Our nonce was consumed, yet our transaction is in no block: another transaction took it.
  if (input.latestNonce > input.txNonce) {
    return {
      status: 'FAILED',
      confirmations: 0,
      failureReason: 'REPLACED_OR_DROPPED',
      stuck: false,
    }
  }
  return {
    status: input.current,
    confirmations: 0,
    failureReason: null,
    stuck: input.now.getTime() - input.broadcastAt.getTime() >= input.stuckAfterMs,
  }
}
