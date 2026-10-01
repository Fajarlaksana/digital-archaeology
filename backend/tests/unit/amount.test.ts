import { describe, expect, it } from 'vitest'
import { Prisma } from '../../src/generated/prisma/client'
import { fromDbAmount, fromDbAmountOrNull, toDbAmount } from '../../src/repositories/amount'

const UINT256_MAX = 2n ** 256n - 1n

describe('DB amount bridge', () => {
  it.each([0n, 1n, 10n ** 18n, UINT256_MAX])('round-trips %s without precision loss', (value) => {
    const decimal = toDbAmount(value)
    expect(decimal.toFixed(0)).toBe(value.toString())
    expect(fromDbAmount(decimal)).toBe(value)
  })

  it('reads values coming back from the DB as strings', () => {
    expect(
      fromDbAmount(
        new Prisma.Decimal(
          '115792089237316195423570985008687907853269984665640564039457584007913129639935',
        ),
      ),
    ).toBe(UINT256_MAX)
  })

  it('refuses non-integer values (base units are always whole)', () => {
    expect(() => fromDbAmount(new Prisma.Decimal('1.5'))).toThrow(/not an integer/)
  })

  it('maps null to null', () => {
    expect(fromDbAmountOrNull(null)).toBeNull()
  })
})
