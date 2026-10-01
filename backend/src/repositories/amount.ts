import { Prisma } from '../generated/prisma/client'
import { parseBaseUnits } from '../domain/money'

/**
 * The ONLY bridge between DB NUMERIC(78,0) values and bigint (ADR-004).
 * Repositories convert at the boundary so services and domain code only ever see bigint.
 */
export function toDbAmount(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString())
}

export function fromDbAmount(value: Prisma.Decimal): bigint {
  if (!value.isInteger()) throw new Error('Base-unit amount in DB is not an integer')
  return parseBaseUnits(value.toFixed(0))
}

export function fromDbAmountOrNull(value: Prisma.Decimal | null): bigint | null {
  return value === null ? null : fromDbAmount(value)
}
