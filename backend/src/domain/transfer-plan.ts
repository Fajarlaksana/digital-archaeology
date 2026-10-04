import type { FeeData } from '../chains/types'
import { maxFeePerGas as feeCap, NATIVE_TRANSFER_GAS } from './eligibility'

/**
 * Transfer planning and approval validity (Phase 9, ADR-022). Pure bigint arithmetic.
 *
 * The approved transaction carries its own tolerance: a fee cap (2 × baseFee + tip, plus the
 * margin), a fixed nonce and an amount. It stays valid only while the network can still include
 * it under that cap, the nonce has not moved and the balance still covers amount + max fee.
 */
export type PlanError =
  | 'NO_BALANCE'
  | 'FEE_EXCEEDS_BALANCE'
  | 'NEEDS_GAS_FUNDING'
  | 'AMOUNT_NOT_POSITIVE'
  | 'AMOUNT_TOO_LARGE'

export interface TransferPlan {
  amount: bigint
  sweep: boolean
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  /** Maximum fee in native base units: gasLimit × maxFeePerGas. */
  networkFee: bigint
}

const withMargin = (value: bigint, marginPercent: number) =>
  (value * BigInt(100 + marginPercent) + 99n) / 100n

export function planTransfer(input: {
  isNative: boolean
  /** Balance of the asset being sent (base units), read live. */
  assetBalance: bigint
  /** Native balance (base units), read live — pays the gas. */
  nativeBalance: bigint
  fees: FeeData
  marginPercent: number
  /** Gas estimate for the token transfer (ignored for native). */
  tokenGasEstimate: bigint | null
  /** null = sweep everything possible; otherwise a smaller test transfer. */
  requestedAmount: bigint | null
}): { ok: true; plan: TransferPlan } | { ok: false; error: PlanError } {
  if (!Number.isInteger(input.marginPercent) || input.marginPercent < 0) {
    throw new Error('marginPercent must be a non-negative integer')
  }
  if (input.requestedAmount !== null && input.requestedAmount <= 0n) {
    return { ok: false, error: 'AMOUNT_NOT_POSITIVE' }
  }
  if (input.assetBalance <= 0n) return { ok: false, error: 'NO_BALANCE' }

  const maxFeePerGas = withMargin(feeCap(input.fees), input.marginPercent)
  const maxPriorityFeePerGas = input.fees.maxPriorityFeePerGas
  let gasLimit: bigint
  if (input.isNative) {
    gasLimit = NATIVE_TRANSFER_GAS
  } else {
    if (input.tokenGasEstimate === null) throw new Error('Token transfer needs a gas estimate')
    gasLimit = withMargin(input.tokenGasEstimate, input.marginPercent)
  }
  const networkFee = gasLimit * maxFeePerGas

  let max: bigint
  if (input.isNative) {
    max = input.assetBalance - networkFee
    if (max <= 0n) return { ok: false, error: 'FEE_EXCEEDS_BALANCE' }
  } else {
    if (input.nativeBalance < networkFee) return { ok: false, error: 'NEEDS_GAS_FUNDING' }
    max = input.assetBalance
  }
  if (input.requestedAmount !== null && input.requestedAmount > max) {
    return { ok: false, error: 'AMOUNT_TOO_LARGE' }
  }
  const amount = input.requestedAmount ?? max
  return {
    ok: true,
    plan: {
      amount,
      sweep: input.requestedAmount === null || input.requestedAmount === max,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      networkFee,
    },
  }
}

export type InvalidReason =
  'APPROVAL_TIMEOUT' | 'NONCE_CHANGED' | 'FEE_ABOVE_CAP' | 'BALANCE_INSUFFICIENT'

/** Returns why an approved / previewed transaction can no longer be used, or null. */
export function checkStillValid(input: {
  tx: { isNative: boolean; nonce: number; amount: bigint; networkFee: bigint; maxFeePerGas: bigint }
  current: { nonce: number; fees: FeeData; nativeBalance: bigint; assetBalance: bigint }
  /** Only for APPROVED transactions. */
  approvalExpiresAt: Date | null
  now: Date
}): InvalidReason | null {
  const { tx, current } = input
  if (input.approvalExpiresAt !== null && input.now >= input.approvalExpiresAt) {
    return 'APPROVAL_TIMEOUT'
  }
  if (current.nonce !== tx.nonce) return 'NONCE_CHANGED'
  if (feeCap(current.fees) > tx.maxFeePerGas) return 'FEE_ABOVE_CAP'
  const enough = tx.isNative
    ? current.nativeBalance >= tx.amount + tx.networkFee
    : current.assetBalance >= tx.amount && current.nativeBalance >= tx.networkFee
  return enough ? null : 'BALANCE_INSUFFICIENT'
}
