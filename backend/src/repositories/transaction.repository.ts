import { Prisma, type TransactionStatus } from '../generated/prisma/client'
import type { Database } from '../lib/prisma'
import { toDbAmount } from './amount'

const INCLUDE = {
  // The native asset is needed to show the fee (always paid in the native coin).
  address: { include: { network: { include: { assets: { where: { isNative: true } } } } } },
  asset: true,
  destination: true,
  createdBy: { select: { id: true, name: true } },
  approvals: {
    orderBy: { createdAt: 'desc' as const },
    include: {
      requestedBy: { select: { id: true, name: true } },
      decidedBy: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.TransactionInclude

export type TransactionWithContext = Prisma.TransactionGetPayload<{ include: typeof INCLUDE }>

/** Statuses in which a transaction still holds the address's nonce. */
export const ACTIVE_STATUSES: TransactionStatus[] = [
  'CREATED',
  'APPROVED',
  'SIGNED',
  'BROADCASTED',
  'PENDING',
]

export function createTransactionRepository(db: Database) {
  /** Ends a transaction without a transfer and gives the address back to eligibility. */
  async function closeWith(
    tx: Prisma.TransactionClient,
    id: string,
    addressId: string,
    from: TransactionStatus[],
    status: 'REJECTED' | 'CANCELLED' | 'EXPIRED',
    reason: string,
  ): Promise<boolean> {
    const result = await tx.transaction.updateMany({
      where: { id, status: { in: from } },
      data: { status, statusReason: reason },
    })
    if (result.count !== 1) return false
    await tx.address.updateMany({
      where: { id: addressId, recoveryStatus: 'IN_PROGRESS' },
      data: { recoveryStatus: 'NONE', recoveryReason: null, eligibilityCheckedAt: null },
    })
    return true
  }

  return {
    /** Address, network, assets, verified authorizations and the chosen destination. */
    previewContext(addressId: string, destinationId: string) {
      return Promise.all([
        db.address.findUnique({
          where: { id: addressId },
          include: {
            network: { include: { assets: true } },
            authorizations: {
              where: { verificationStatus: 'VERIFIED' },
              select: { expiresAt: true },
            },
          },
        }),
        db.destination.findUnique({ where: { id: destinationId } }),
      ])
    },

    verifiedAuthorizations(addressId: string) {
      return db.authorization.findMany({
        where: { addressId, verificationStatus: 'VERIFIED' },
        select: { expiresAt: true },
      })
    },

    /**
     * Creates the transaction (CREATED), its open approval request and marks the address
     * IN_PROGRESS. Returns null when the address already has a transaction in flight.
     */
    async create(data: {
      addressId: string
      networkId: string
      assetId: string
      destinationId: string
      createdById: string
      amount: bigint
      sweep: boolean
      nonce: number
      gasLimit: bigint
      maxFeePerGas: bigint
      maxPriorityFeePerGas: bigint
      networkFee: bigint
      recipient: string
      estimatedValue: string | null
      valueSimulated: boolean
      unsignedPayload: Record<string, string | number>
      unsignedHash: string
    }): Promise<{ id: string } | null> {
      try {
        return await db.$transaction(async (tx) => {
          const created = await tx.transaction.create({
            data: {
              ...data,
              amount: toDbAmount(data.amount),
              gasLimit: toDbAmount(data.gasLimit),
              maxFeePerGas: toDbAmount(data.maxFeePerGas),
              maxPriorityFeePerGas: toDbAmount(data.maxPriorityFeePerGas),
              networkFee: toDbAmount(data.networkFee),
              estimatedValue:
                data.estimatedValue === null ? null : new Prisma.Decimal(data.estimatedValue),
              unsignedPayload: data.unsignedPayload,
              status: 'CREATED',
            },
            select: { id: true },
          })
          await tx.approval.create({
            data: {
              subjectType: 'TRANSACTION',
              transactionId: created.id,
              requestedById: data.createdById,
            },
          })
          await tx.address.update({
            where: { id: data.addressId },
            data: { recoveryStatus: 'IN_PROGRESS', recoveryReason: null },
          })
          return created
        })
      } catch (error) {
        // transactions_one_active_per_address
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return null
        }
        throw error
      }
    },

    findById(id: string): Promise<TransactionWithContext | null> {
      return db.transaction.findUnique({ where: { id }, include: INCLUDE })
    },

    list(filter: { status?: TransactionStatus; addressId?: string }) {
      return db.transaction.findMany({
        where: filter,
        include: INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
    },

    /** APPROVED transactions whose approval window has passed. */
    overdueApprovals(at: Date) {
      return db.transaction.findMany({
        where: {
          status: 'APPROVED',
          approvals: { some: { decision: 'APPROVED', expiresAt: { lte: at } } },
        },
        select: { id: true, addressId: true },
      })
    },

    openApproval(transactionId: string) {
      return db.approval.findFirst({
        where: { transactionId, decision: null },
        orderBy: { createdAt: 'desc' },
      })
    },

    /** Approval row first (the DB trigger requires it), then the status — atomically. */
    async approve(input: {
      id: string
      approvalId: string
      decidedById: string
      reason: string
      at: Date
      expiresAt: Date
    }): Promise<boolean> {
      return db
        .$transaction(async (tx) => {
          const approval = await tx.approval.updateMany({
            where: { id: input.approvalId, decision: null },
            data: {
              decision: 'APPROVED',
              decidedById: input.decidedById,
              reason: input.reason,
              decidedAt: input.at,
              expiresAt: input.expiresAt,
            },
          })
          if (approval.count !== 1) throw new Concurrent()
          const updated = await tx.transaction.updateMany({
            where: { id: input.id, status: 'CREATED' },
            data: { status: 'APPROVED' },
          })
          if (updated.count !== 1) throw new Concurrent()
          return true
        })
        .catch((error: unknown) => {
          if (error instanceof Concurrent) return false
          throw error
        })
    },

    async reject(input: {
      id: string
      addressId: string
      approvalId: string
      decidedById: string
      reason: string
      at: Date
    }): Promise<boolean> {
      return db
        .$transaction(async (tx) => {
          const approval = await tx.approval.updateMany({
            where: { id: input.approvalId, decision: null },
            data: {
              decision: 'REJECTED',
              decidedById: input.decidedById,
              reason: input.reason,
              decidedAt: input.at,
            },
          })
          if (approval.count !== 1) throw new Concurrent()
          if (
            !(await closeWith(tx, input.id, input.addressId, ['CREATED'], 'REJECTED', input.reason))
          )
            throw new Concurrent()
          return true
        })
        .catch((error: unknown) => {
          if (error instanceof Concurrent) return false
          throw error
        })
    },

    close(
      id: string,
      addressId: string,
      from: TransactionStatus[],
      status: 'CANCELLED' | 'EXPIRED',
      reason: string,
    ): Promise<boolean> {
      return db.$transaction((tx) => closeWith(tx, id, addressId, from, status, reason))
    },
  }
}

class Concurrent extends Error {}

export type TransactionRepository = ReturnType<typeof createTransactionRepository>
