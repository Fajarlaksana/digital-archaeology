import type { FeeData } from '../chains/types'
import { compareFiat, fiatValue, subtractFiat } from './valuation'

/**
 * Recovery eligibility (SA 4.7 + docs/02 §2.6, Phase 8b). Pure: every input is passed in, so each
 * rule is unit-tested. Amounts are base-unit bigints; fiat values are decimal strings.
 *
 * The result is INFORMATION for a human. Nothing moves assets because of it (CLAUDE.md rule 5).
 */
export type EligibilityStatus = 'READY' | 'NOT_ELIGIBLE' | 'NOT_ECONOMIC'

export type EligibilityReason =
  // Address-level (apply to every asset)
  | 'STALE_BALANCE'
  | 'NO_BALANCE'
  | 'AUTH_NOT_VERIFIED'
  | 'AUTH_EXPIRED'
  | 'NO_APPROVED_DESTINATION'
  | 'NO_KEY_IN_VAULT'
  | 'SIGNER_UNAVAILABLE'
  // Asset-level
  | 'NO_PRICE'
  | 'FEE_UNAVAILABLE'
  | 'FEE_EXCEEDS_BALANCE'
  | 'BELOW_MINIMUM'
  | 'NEEDS_GAS_FUNDING'

/** A plain ETH transfer to an EOA (destinations are proven EOAs, ADR-020). */
export const NATIVE_TRANSFER_GAS = 21_000n

/** EIP-1559 cap that survives a doubling of the base fee: 2 × baseFee + tip. */
export function maxFeePerGas(fee: FeeData): bigint {
  return 2n * fee.baseFeePerGas + fee.maxPriorityFeePerGas
}

/** gas × maxFeePerGas, plus a safety margin in percent, rounded UP (never underestimate). */
export function estimateFee(gas: bigint, fee: FeeData, marginPercent: number): bigint {
  if (!Number.isInteger(marginPercent) || marginPercent < 0) {
    throw new Error('marginPercent must be a non-negative integer')
  }
  const raw = gas * maxFeePerGas(fee)
  return (raw * BigInt(100 + marginPercent) + 99n) / 100n
}

export interface AddressGates {
  /** VERIFIED = a verified authorization that has not expired (ADR-018). */
  authorization: 'VERIFIED' | 'EXPIRED' | 'MISSING'
  approvedDestination: boolean
  /** null = the signer could not be asked. */
  keyInVault: boolean | null
  balanceFresh: boolean
}

export interface AssetInput {
  assetId: string
  isNative: boolean
  decimals: number
  quantity: bigint
  /** Price of one whole unit; null when unknown. */
  price: string | null
  /** Fee to transfer this asset, in NATIVE base units; null when it could not be estimated. */
  fee: bigint | null
}

export interface AssetResult {
  assetId: string
  status: EligibilityStatus
  reason: EligibilityReason | null
  quantity: bigint
  fee: bigint | null
  valueFiat: string | null
  feeFiat: string | null
  /** What would arrive, in fiat, after the fee. */
  netFiat: string | null
}

export interface AddressResult {
  status: EligibilityStatus
  /** Distinct reasons, most relevant first; empty when READY. */
  reasons: EligibilityReason[]
  assets: AssetResult[]
}

const RANK: Record<EligibilityStatus, number> = { READY: 0, NOT_ECONOMIC: 1, NOT_ELIGIBLE: 2 }

function gateReason(gates: AddressGates): EligibilityReason | null {
  if (gates.authorization === 'MISSING') return 'AUTH_NOT_VERIFIED'
  if (gates.authorization === 'EXPIRED') return 'AUTH_EXPIRED'
  if (!gates.approvedDestination) return 'NO_APPROVED_DESTINATION'
  if (gates.keyInVault === null) return 'SIGNER_UNAVAILABLE'
  if (!gates.keyInVault) return 'NO_KEY_IN_VAULT'
  return null
}

export function evaluateAddress(input: {
  gates: AddressGates
  assets: AssetInput[]
  /** Minimum fiat that must arrive after fees; at or below it the asset is NOT_ECONOMIC. */
  minNetValue: string
}): AddressResult {
  const held = input.assets.filter((a) => a.quantity > 0n)
  const native = input.assets.find((a) => a.isNative) ?? null
  const blank = (
    a: AssetInput,
    status: EligibilityStatus,
    reason: EligibilityReason | null,
  ): AssetResult => ({
    assetId: a.assetId,
    status,
    reason,
    quantity: a.quantity,
    fee: a.fee,
    valueFiat: a.price === null ? null : fiatValue(a.quantity, a.decimals, a.price),
    feeFiat: null,
    netFiat: null,
  })

  // 1. Nothing can be trusted on an old balance; nothing to do without one.
  if (!input.gates.balanceFresh) {
    return finish(
      held.map((a) => blank(a, 'NOT_ELIGIBLE', 'STALE_BALANCE')),
      'STALE_BALANCE',
    )
  }
  if (held.length === 0) return finish([], 'NO_BALANCE')

  // 2. Legal basis, destination and key apply to the whole address.
  const gate = gateReason(input.gates)
  if (gate)
    return finish(
      held.map((a) => blank(a, 'NOT_ELIGIBLE', gate)),
      gate,
    )

  // 3. Per asset. Tokens first: the gas they need is reserved from the native balance.
  const nativePrice = native?.price ?? null
  const feeFiat = (fee: bigint) =>
    native === null || nativePrice === null ? null : fiatValue(fee, native.decimals, nativePrice)
  const results: AssetResult[] = []
  let reservedForTokens = 0n

  for (const token of held.filter((a) => !a.isNative)) {
    if (token.price === null || nativePrice === null) {
      results.push(blank(token, 'NOT_ELIGIBLE', 'NO_PRICE'))
      continue
    }
    if (token.fee === null) {
      results.push(blank(token, 'NOT_ELIGIBLE', 'FEE_UNAVAILABLE'))
      continue
    }
    const value = fiatValue(token.quantity, token.decimals, token.price)
    const fee = feeFiat(token.fee)!
    const net = subtractFiat(value, fee)
    const base = { ...blank(token, 'READY', null), valueFiat: value, feeFiat: fee, netFiat: net }
    if (compareFiat(net, input.minNetValue) <= 0) {
      results.push({ ...base, status: 'NOT_ECONOMIC', reason: 'BELOW_MINIMUM' })
    } else if ((native?.quantity ?? 0n) - reservedForTokens < token.fee) {
      // Worth recovering, but the address has no native coin to pay gas: a human decides.
      results.push({ ...base, status: 'NOT_ELIGIBLE', reason: 'NEEDS_GAS_FUNDING' })
    } else {
      reservedForTokens += token.fee
      results.push({ ...base, status: 'READY', reason: null })
    }
  }

  if (native && native.quantity > 0n) {
    if (native.price === null) {
      results.unshift(blank(native, 'NOT_ELIGIBLE', 'NO_PRICE'))
    } else if (native.fee === null) {
      results.unshift(blank(native, 'NOT_ELIGIBLE', 'FEE_UNAVAILABLE'))
    } else {
      // Sweep: send everything except this transfer's fee and the gas reserved for tokens.
      const available = native.quantity - reservedForTokens - native.fee
      const value = fiatValue(native.quantity, native.decimals, native.price)
      const fee = feeFiat(native.fee)!
      if (available <= 0n) {
        results.unshift({
          ...blank(native, 'NOT_ECONOMIC', 'FEE_EXCEEDS_BALANCE'),
          feeFiat: fee,
          netFiat: '0.00000000',
        })
      } else {
        const net = fiatValue(available, native.decimals, native.price)
        const below = compareFiat(net, input.minNetValue) <= 0
        results.unshift({
          ...blank(native, below ? 'NOT_ECONOMIC' : 'READY', below ? 'BELOW_MINIMUM' : null),
          valueFiat: value,
          feeFiat: fee,
          netFiat: net,
        })
      }
    }
  }
  return finish(results, null)
}

/** The address takes its BEST asset status (one READY asset makes the address READY). */
function finish(assets: AssetResult[], addressReason: EligibilityReason | null): AddressResult {
  if (addressReason) {
    return { status: 'NOT_ELIGIBLE', reasons: [addressReason], assets }
  }
  const best = assets.reduce<EligibilityStatus>(
    (acc, a) => (RANK[a.status] < RANK[acc] ? a.status : acc),
    'NOT_ELIGIBLE',
  )
  const reasons = [
    ...new Set(
      [...assets]
        .sort((x, y) => RANK[x.status] - RANK[y.status])
        .flatMap((a) => (a.reason ? [a.reason] : [])),
    ),
  ]
  return { status: best, reasons: best === 'READY' ? [] : reasons, assets }
}
