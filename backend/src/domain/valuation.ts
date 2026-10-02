import Decimal from 'decimal.js'

/**
 * Fiat valuation (SA 4.4, ADR-016). Pure, exact decimal arithmetic — never JS floats.
 * Amounts are base-unit bigints; prices are decimal strings for ONE whole unit.
 * The result is an ESTIMATE and never a basis for ownership (SA 4.4).
 */

/** Plenty of precision for uint256 × price; results are rounded only at the end. */
const D = Decimal.clone({ precision: 120, rounding: Decimal.ROUND_HALF_UP })

export const FIAT_DECIMALS = 8

const PRICE_PATTERN = /^(\d+(\.\d+)?|\d+(\.\d+)?e[-+]?\d+)$/i

/**
 * Normalises a price received from an API into a plain decimal string.
 * JSON prices arrive as numbers; String(number) gives the shortest exact representation of what
 * was sent, which is then handled as a decimal — no arithmetic happens on the float.
 */
export function normalizePrice(raw: number | string): string {
  const text = String(raw).trim()
  if (!PRICE_PATTERN.test(text)) throw new Error(`Invalid price: ${text}`)
  const value = new D(text)
  if (value.isNegative() || !value.isFinite()) throw new Error(`Invalid price: ${text}`)
  return value.toFixed()
}

/** quantity (base units) / 10^decimals × price → fiat string with 8 decimals. */
export function fiatValue(quantity: bigint, decimals: number, price: string): string {
  return new D(quantity.toString())
    .div(new D(10).pow(decimals))
    .mul(new D(price))
    .toFixed(FIAT_DECIMALS)
}

/** Exact sum of fiat strings. */
export function sumFiat(values: readonly string[]): string {
  return values.reduce((acc, v) => acc.plus(new D(v)), new D(0)).toFixed(FIAT_DECIMALS)
}

/** Display form: 2 decimals for normal values, more when tiny but non-zero (e.g. dust). */
export function displayFiat(value: string): string {
  const v = new D(value)
  if (v.isZero()) return '0.00'
  if (v.abs().lt(0.01)) return v.toSignificantDigits(2).toFixed()
  return v.toFixed(2)
}
