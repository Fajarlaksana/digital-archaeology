import type {
  AuthorizationStatus,
  AuthorizationType,
  ChallengeMethod,
  ChallengeResult,
  Prisma,
} from '../generated/prisma/client'
import type { Database } from '../lib/prisma'

const WITH_ADDRESS = {
  address: { include: { network: true } },
} satisfies Prisma.AuthorizationInclude

export type AuthorizationWithAddress = Prisma.AuthorizationGetPayload<{
  include: typeof WITH_ADDRESS & { challenges: true }
}>
export type ChallengeWithContext = Prisma.OwnershipChallengeGetPayload<{
  include: { authorization: true; address: { include: { network: true } } }
}>

export function createAuthorizationRepository(db: Database) {
  const include = {
    ...WITH_ADDRESS,
    challenges: { orderBy: { issuedAt: 'desc' as const }, take: 5 },
  }

  return {
    create(data: {
      addressId: string
      type: AuthorizationType
      reference: string
      documentSha256: string | null
      documentName: string | null
      expiresAt: Date | null
      createdById: string
    }): Promise<AuthorizationWithAddress> {
      return db.authorization.create({ data: { ...data, verificationStatus: 'PENDING' }, include })
    },

    findById(id: string): Promise<AuthorizationWithAddress | null> {
      return db.authorization.findUnique({ where: { id }, include })
    },

    listForAddress(addressId: string): Promise<AuthorizationWithAddress[]> {
      return db.authorization.findMany({
        where: { addressId },
        include,
        orderBy: { createdAt: 'desc' },
      })
    },

    listRecent(
      status: AuthorizationStatus | undefined,
      take: number,
    ): Promise<AuthorizationWithAddress[]> {
      return db.authorization.findMany({
        where: status ? { verificationStatus: status } : {},
        include,
        orderBy: { createdAt: 'desc' },
        take,
      })
    },

    /** A new (pending) authorization moves an unverified address to PENDING; VERIFIED stays. */
    async markAddressPending(addressId: string): Promise<void> {
      await db.address.updateMany({
        where: { id: addressId, authorizationStatus: { not: 'VERIFIED' } },
        data: { authorizationStatus: 'PENDING' },
      })
    },

    async markVerified(authorizationId: string, addressId: string, at: Date): Promise<void> {
      await db.$transaction([
        db.authorization.update({
          where: { id: authorizationId },
          data: { verificationStatus: 'VERIFIED', verifiedAt: at },
        }),
        db.address.update({ where: { id: addressId }, data: { authorizationStatus: 'VERIFIED' } }),
      ])
    },

    createChallenge(data: {
      addressId: string
      authorizationId: string
      nonce: string
      message: string
      issuedAt: Date
      expiresAt: Date
      createdById: string
    }) {
      return db.ownershipChallenge.create({ data })
    },

    findChallenge(id: string): Promise<ChallengeWithContext | null> {
      return db.ownershipChallenge.findUnique({
        where: { id },
        include: { authorization: true, address: { include: { network: true } } },
      })
    },

    /**
     * Marks the challenge used. Returns false when it was already used — atomic, so two
     * concurrent submissions cannot both be evaluated (single use, docs/02 §2.4).
     */
    async consume(id: string, at: Date): Promise<boolean> {
      const result = await db.ownershipChallenge.updateMany({
        where: { id, usedAt: null },
        data: { usedAt: at },
      })
      return result.count === 1
    },

    async setResult(
      id: string,
      data: { result: ChallengeResult; method: ChallengeMethod; signature: string | null },
    ): Promise<void> {
      await db.ownershipChallenge.update({ where: { id }, data })
    },
  }
}

export type AuthorizationRepository = ReturnType<typeof createAuthorizationRepository>
