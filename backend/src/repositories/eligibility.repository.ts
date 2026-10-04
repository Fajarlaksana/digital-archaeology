import { Prisma, type RecoveryStatus } from '../generated/prisma/client'
import type { AddressResult } from '../domain/eligibility'
import type { Database } from '../lib/prisma'
import { fromDbAmount, fromDbAmountOrNull, toDbAmount } from './amount'

/** Recovery workflow states that eligibility must never overwrite (Phase 9+ owns them). */
const IN_WORKFLOW: RecoveryStatus[] = ['IN_PROGRESS', 'TRANSFERRED']

export interface EligibilityCandidate {
  id: string
  address: string
  lastScannedAt: Date | null
  /** Expiry of every VERIFIED authorization (null = never expires); empty = none verified. */
  verifiedAuthorizations: Array<{ expiresAt: Date | null }>
  balances: Array<{
    assetId: string
    isNative: boolean
    contractAddress: string | null
    decimals: number
    quantity: bigint
  }>
}

const fiat = (value: string | null) => (value === null ? null : new Prisma.Decimal(value))

export function createEligibilityRepository(db: Database) {
  return {
    /** Active (not archived) addresses of a network that are not in a recovery workflow. */
    async candidates(networkId: string): Promise<EligibilityCandidate[]> {
      const rows = await db.address.findMany({
        where: { networkId, archivedAt: null, recoveryStatus: { notIn: IN_WORKFLOW } },
        include: {
          balances: { include: { asset: true } },
          authorizations: {
            where: { verificationStatus: 'VERIFIED' },
            select: { expiresAt: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      })
      return rows.map((r) => ({
        id: r.id,
        address: r.address,
        lastScannedAt: r.lastScannedAt,
        verifiedAuthorizations: r.authorizations,
        balances: r.balances.map((b) => ({
          assetId: b.assetId,
          isNative: b.asset.isNative,
          contractAddress: b.asset.contractAddress,
          decimals: b.asset.decimals,
          quantity: fromDbAmount(b.quantity),
        })),
      }))
    },

    /** Any APPROVED destination of the network (used as `to` for gas estimates). */
    approvedDestination(networkId: string) {
      return db.destination.findFirst({
        where: { networkId, status: 'APPROVED' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, address: true },
      })
    },

    /** Replaces the address's results and updates its summary atomically. */
    async save(addressId: string, result: AddressResult, simulated: boolean, at: Date) {
      await db.$transaction([
        db.assetEligibility.deleteMany({ where: { addressId } }),
        db.assetEligibility.createMany({
          data: result.assets.map((a) => ({
            addressId,
            assetId: a.assetId,
            status: a.status,
            reason: a.reason,
            quantity: toDbAmount(a.quantity),
            feeEstimate: a.fee === null ? null : toDbAmount(a.fee),
            valueFiat: fiat(a.valueFiat),
            feeFiat: fiat(a.feeFiat),
            netFiat: fiat(a.netFiat),
            simulated,
            computedAt: at,
          })),
        }),
        // Conditional: if the address entered a recovery workflow meanwhile, leave it alone.
        db.address.updateMany({
          where: { id: addressId, recoveryStatus: { notIn: IN_WORKFLOW } },
          data: {
            recoveryStatus: result.status,
            recoveryReason: result.reasons.length ? result.reasons.join(',') : null,
            eligibilityCheckedAt: at,
          },
        }),
      ])
    },

    async forAddress(addressId: string) {
      const rows = await db.assetEligibility.findMany({
        where: { addressId },
        include: { asset: true },
        orderBy: [{ asset: { isNative: 'desc' } }, { asset: { symbol: 'asc' } }],
      })
      return rows.map((r) => ({
        assetId: r.assetId,
        symbol: r.asset.symbol,
        decimals: r.asset.decimals,
        isNative: r.asset.isNative,
        status: r.status,
        reason: r.reason,
        quantity: fromDbAmount(r.quantity),
        feeEstimate: fromDbAmountOrNull(r.feeEstimate),
        valueFiat: r.valueFiat?.toFixed(8) ?? null,
        feeFiat: r.feeFiat?.toFixed(8) ?? null,
        netFiat: r.netFiat?.toFixed(8) ?? null,
        simulated: r.simulated,
        computedAt: r.computedAt,
      }))
    },
  }
}

export type EligibilityRepository = ReturnType<typeof createEligibilityRepository>
