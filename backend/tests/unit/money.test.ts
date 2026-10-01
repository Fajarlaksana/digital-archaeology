import { describe, expect, it } from 'vitest'
import {
  AmountError,
  fromBaseUnit,
  MAX_BASE_UNITS,
  parseBaseUnits,
  toBaseUnit,
} from '../../src/domain/money'

const UINT256_MAX = 2n ** 256n - 1n

describe('toBaseUnit', () => {
  it.each([
    ['0', 18, 0n],
    ['1', 18, 10n ** 18n],
    ['1.5', 18, 1_500_000_000_000_000_000n],
    ['0.000000000000000001', 18, 1n], // 1 wei
    ['0.00000001', 8, 1n], // 1 satoshi
    ['21000000', 8, 2_100_000_000_000_000n], // all bitcoin
    ['123.456', 6, 123_456_000n], // USDC
    ['1.500', 2, 150n], // trailing zeros beyond precision are fine
    ['42', 0, 42n],
    ['  7.25 ', 2, 725n],
  ])('%s with %i decimals → %s', (amount, decimals, expected) => {
    expect(toBaseUnit(amount, decimals)).toBe(expected)
  })

  it('handles uint256 max exactly', () => {
    expect(toBaseUnit(UINT256_MAX.toString(), 0)).toBe(UINT256_MAX)
  })

  it('never rounds: rejects precision finer than the asset supports', () => {
    expect(() => toBaseUnit('0.0000000000000000001', 18)).toThrow(AmountError)
    expect(() => toBaseUnit('1.001', 2)).toThrow(/more than 2 decimal places/)
  })

  it.each(['', '-1', '+1', '1e18', '0x10', '1.', '.5', '1,5', 'abc', 'NaN', 'Infinity', '1.2.3'])(
    'rejects invalid input %j',
    (amount) => {
      expect(() => toBaseUnit(amount, 18)).toThrow(AmountError)
    },
  )

  it('rejects values beyond NUMERIC(78,0)', () => {
    expect(() => toBaseUnit('1' + '0'.repeat(78), 0)).toThrow(/range/)
  })

  it.each([-1, 1.5, 37, Number.NaN])('rejects decimals=%s', (decimals) => {
    expect(() => toBaseUnit('1', decimals)).toThrow(/decimals/)
  })
})

describe('fromBaseUnit', () => {
  it.each([
    [0n, 18, '0'],
    [1n, 18, '0.000000000000000001'],
    [10n ** 18n, 18, '1'],
    [1_500_000_000_000_000_000n, 18, '1.5'],
    [123_456_000n, 6, '123.456'],
    [1n, 8, '0.00000001'],
    [42n, 0, '42'],
  ])('%s with %i decimals → %s', (value, decimals, expected) => {
    expect(fromBaseUnit(value, decimals)).toBe(expected)
  })

  it('rejects negative values', () => {
    expect(() => fromBaseUnit(-1n, 18)).toThrow(AmountError)
  })

  it('round-trips exactly', () => {
    for (const [value, decimals] of [
      [UINT256_MAX, 18],
      [MAX_BASE_UNITS, 18],
      [987_654_321_123_456_789n, 18],
      [1n, 36],
    ] as const) {
      expect(toBaseUnit(fromBaseUnit(value, decimals), decimals)).toBe(value)
    }
  })

  it('shows why floats are banned', () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004; in base units it is exact.
    const sum = toBaseUnit('0.1', 18) + toBaseUnit('0.2', 18)
    expect(fromBaseUnit(sum, 18)).toBe('0.3')
  })
})

describe('parseBaseUnits', () => {
  it('parses DB/JSON integer strings', () => {
    expect(parseBaseUnits('1500000000000000000')).toBe(1_500_000_000_000_000_000n)
    expect(parseBaseUnits('0')).toBe(0n)
  })

  it.each(['1.5', '-1', '1e3', ' 1', '', '0x1'])('rejects %j', (value) => {
    expect(() => parseBaseUnits(value)).toThrow(AmountError)
  })
})
