/**
 * Exact conversion between human-readable amounts ("1.5") and base units (wei, satoshi).
 * Pure: no Prisma, no viem, no floating point (CLAUDE.md rule 8, ADR-004).
 */

const MAX_DECIMALS = 36
/** Largest value storable in NUMERIC(78,0) — covers uint256. */
export const MAX_BASE_UNITS = 10n ** 78n - 1n

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/

export class AmountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmountError'
  }
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AmountError(`decimals must be an integer between 0 and ${MAX_DECIMALS}`)
  }
}

function assertInRange(value: bigint): void {
  if (value < 0n) throw new AmountError('Amount must not be negative')
  if (value > MAX_BASE_UNITS) throw new AmountError('Amount exceeds NUMERIC(78,0) range')
}

/**
 * "1.5" with 18 decimals → 1500000000000000000n.
 * Rejects anything that is not a plain non-negative decimal, and any precision the asset
 * cannot represent (no silent rounding).
 */
export function toBaseUnit(amount: string, decimals: number): bigint {
  assertDecimals(decimals)
  const match = DECIMAL_PATTERN.exec(amount.trim())
  if (!match) throw new AmountError(`Invalid amount format: "${amount}"`)

  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > decimals) {
    throw new AmountError(`Amount has more than ${decimals} decimal places`)
  }

  const value = BigInt(whole + fraction.padEnd(decimals, '0'))
  assertInRange(value)
  return value
}

/** 1500000000000000000n with 18 decimals → "1.5". Trailing zeros are trimmed. */
export function fromBaseUnit(value: bigint, decimals: number): string {
  assertDecimals(decimals)
  assertInRange(value)
  if (decimals === 0) return value.toString()

  const digits = value.toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, -decimals)
  const fraction = digits.slice(-decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/**
 * Parses a base-unit integer string as stored in the DB / JSON ("1500000000000000000").
 * Rejects decimals, signs, exponents and whitespace-padded junk.
 */
export function parseBaseUnits(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new AmountError(`Invalid base-unit value: "${value}"`)
  const parsed = BigInt(value)
  assertInRange(parsed)
  return parsed
}
