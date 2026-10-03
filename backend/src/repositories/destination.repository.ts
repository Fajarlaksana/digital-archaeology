import type {
  ChallengeMethod,
  ChallengeResult,
  DestinationStatus,
  Prisma,
} from '../generated/prisma/client'
import type { Database } from '../lib/prisma'

const INCLUDE = {
  network: true,
  createdBy: { select: { id: true, name: true } },
  controlVerifier: { select: { id: true, name: true } },
  approvals: {
    orderBy: { createdAt: 'desc' as const },
    include: {
      requestedBy: { select: { id: true, name: true } },
      decidedBy: { select: { id: true, name: true } },
    },
  },
  challenges: { orderBy: { issuedAt: 'desc' as const }, take: 5 },
} satisfies Prisma.DestinationInclude

export type DestinationWithContext = Prisma.DestinationGetPayload<{ include: typeof INCLUDE }>
export type DestinationChallengeWithContext = Prisma.DestinationChallengeGetPayload<{
  include: { destination: { include: { network: true } } }
}>

export function createDestinationRepository(db: Database) {
  return {
    findById(id: string): Promise<DestinationWithContext | null> {
      return db.destination.findUnique({ where: { id }, include: INCLUDE })
    },

    findByNetworkAndAddress(networkId: string, address: string) {
      return db.destination.findUnique({ where: { networkId_address: { networkId, address } } })
    },

    list(filter: { networkId?: string; status?: DestinationStatus }) {
      return db.destination.findMany({
        where: { networkId: filter.networkId, status: filter.status },
        include: INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
    },

    /** Creates the destination and its open approval request in one transaction. */
    async create(data: {
      networkId: string
      address: string
      label: string
      createdById: string
    }): Promise<{ id: string }> {
      return db.$transaction(async (tx) => {
        const destination = await tx.destination.create({ data, select: { id: true } })
        await tx.approval.create({
          data: {
            subjectType: 'DESTINATION',
            destinationId: destination.id,
            requestedById: data.createdById,
          },
        })
        return destination
      })
    },

    /** The undecided approval request of a destination, if any. */
    openApproval(destinationId: string) {
      return db.approval.findFirst({
        where: { destinationId, subjectType: 'DESTINATION', decision: null },
        orderBy: { createdAt: 'desc' },
      })
    },

    /**
     * Records the REVIEWER decision. Conditional updates make it race-free: only a destination
     * that is still PENDING (and, for approval, proven) and an approval that is still open change.
     * Returns false when either was decided concurrently.
     */
    async decide(input: {
      destinationId: string
      approvalId: string
      decision: 'APPROVED' | 'REJECTED'
      decidedById: string
      reason: string | null
      at: Date
    }): Promise<boolean> {
      return db
        .$transaction(async (tx) => {
          const approval = await tx.approval.updateMany({
            where: { id: input.approvalId, decision: null },
            data: {
              decision: input.decision,
              decidedById: input.decidedById,
              reason: input.reason,
              decidedAt: input.at,
            },
          })
          if (approval.count !== 1) return false
          const destination = await tx.destination.updateMany({
            where: {
              id: input.destinationId,
              status: 'PENDING_APPROVAL',
              ...(input.decision === 'APPROVED' ? { controlVerifiedAt: { not: null } } : {}),
            },
            data: { status: input.decision, statusReason: input.reason },
          })
          if (destination.count !== 1) throw new ConcurrentChange()
          return true
        })
        .catch((error: unknown) => {
          if (error instanceof ConcurrentChange) return false
          throw error
        })
    },

    async disable(id: string, reason: string): Promise<boolean> {
      const result = await db.destination.updateMany({
        where: { id, status: 'APPROVED' },
        data: { status: 'DISABLED', statusReason: reason },
      })
      return result.count === 1
    },

    /** Back to PENDING_APPROVAL with a fresh approval request; the old proof no longer counts. */
    async resubmit(id: string, requestedById: string): Promise<boolean> {
      return db.$transaction(async (tx) => {
        const result = await tx.destination.updateMany({
          where: { id, status: { in: ['REJECTED', 'DISABLED'] } },
          data: {
            status: 'PENDING_APPROVAL',
            statusReason: null,
            controlVerifiedAt: null,
            controlVerifiedById: null,
          },
        })
        if (result.count !== 1) return false
        await tx.approval.create({
          data: { subjectType: 'DESTINATION', destinationId: id, requestedById },
        })
        return true
      })
    },

    createChallenge(data: {
      destinationId: string
      nonce: string
      message: string
      issuedAt: Date
      expiresAt: Date
      createdById: string
    }) {
      return db.destinationChallenge.create({ data })
    },

    findChallenge(id: string): Promise<DestinationChallengeWithContext | null> {
      return db.destinationChallenge.findUnique({
        where: { id },
        include: { destination: { include: { network: true } } },
      })
    },

    /** Marks the challenge used; false when it already was (single use, atomic). */
    async consumeChallenge(id: string, at: Date): Promise<boolean> {
      const result = await db.destinationChallenge.updateMany({
        where: { id, usedAt: null },
        data: { usedAt: at },
      })
      return result.count === 1
    },

    async setChallengeResult(
      id: string,
      data: { result: ChallengeResult; method: ChallengeMethod; signature: string | null },
    ): Promise<void> {
      await db.destinationChallenge.update({ where: { id }, data })
    },

    /** Records the proof — only while the destination still awaits a decision. */
    async markControlVerified(id: string, userId: string, at: Date): Promise<boolean> {
      const result = await db.destination.updateMany({
        where: { id, status: 'PENDING_APPROVAL' },
        data: { controlVerifiedAt: at, controlVerifiedById: userId },
      })
      return result.count === 1
    },
  }
}

class ConcurrentChange extends Error {}

export type DestinationRepository = ReturnType<typeof createDestinationRepository>
