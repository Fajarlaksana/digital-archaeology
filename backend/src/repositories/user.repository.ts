import type { Prisma, Role, User, UserRole, UserStatus } from '../generated/prisma/client'
import type { Database } from '../lib/prisma'

export type UserWithRoles = User & { roles: UserRole[] }

export interface NewUser {
  email: string
  name: string
  passwordHash: string
  roles: Role[]
  grantedById?: string | null
}

const withRoles = { roles: { orderBy: { role: 'asc' } } } satisfies Prisma.UserInclude

export function roleList(user: UserWithRoles): Role[] {
  return user.roles.map((r) => r.role)
}

export function createUserRepository(db: Database) {
  return {
    findByEmail(email: string): Promise<UserWithRoles | null> {
      return db.user.findUnique({ where: { email: email.toLowerCase() }, include: withRoles })
    },

    findById(id: string): Promise<UserWithRoles | null> {
      return db.user.findUnique({ where: { id }, include: withRoles })
    },

    list(): Promise<UserWithRoles[]> {
      return db.user.findMany({ include: withRoles, orderBy: { createdAt: 'asc' } })
    },

    create(input: NewUser): Promise<UserWithRoles> {
      return db.user.create({
        data: {
          email: input.email.toLowerCase(),
          name: input.name,
          passwordHash: input.passwordHash,
          roles: {
            create: input.roles.map((role) => ({ role, grantedById: input.grantedById ?? null })),
          },
        },
        include: withRoles,
      })
    },

    async update(
      id: string,
      data: { name?: string; status?: UserStatus; roles?: Role[]; grantedById?: string | null },
    ): Promise<UserWithRoles> {
      return db.$transaction(async (tx) => {
        if (data.roles) {
          await tx.userRole.deleteMany({ where: { userId: id } })
          await tx.userRole.createMany({
            data: data.roles.map((role) => ({
              userId: id,
              role,
              grantedById: data.grantedById ?? null,
            })),
          })
        }
        return tx.user.update({
          where: { id },
          data: {
            name: data.name,
            status: data.status,
            // Re-activating an account also clears the failed-login counter (unlock).
            ...(data.status === 'ACTIVE' ? { failedLoginCount: 0 } : {}),
          },
          include: withRoles,
        })
      })
    },

    /** Increments the failure counter and locks the account at `lockThreshold`. Returns the new status. */
    async recordFailedLogin(id: string, lockThreshold: number): Promise<UserStatus> {
      const user = await db.user.update({
        where: { id },
        data: { failedLoginCount: { increment: 1 } },
      })
      if (user.status === 'ACTIVE' && user.failedLoginCount >= lockThreshold) {
        await db.user.update({ where: { id }, data: { status: 'LOCKED' } })
        return 'LOCKED'
      }
      return user.status
    },

    async recordSuccessfulLogin(id: string, at: Date): Promise<void> {
      await db.user.update({ where: { id }, data: { failedLoginCount: 0, lastLoginAt: at } })
    },

    /** Stores a new (not yet confirmed) TOTP secret, already encrypted. */
    async setPendingMfaSecret(id: string, encryptedSecret: string): Promise<void> {
      await db.user.update({
        where: { id },
        data: { mfaSecretEncrypted: encryptedSecret, mfaEnabled: false, mfaLastUsedStep: null },
      })
    },

    /** Forgets the authenticator: the user must set up MFA again at the next login. */
    async resetMfa(id: string): Promise<void> {
      await db.user.update({
        where: { id },
        data: { mfaSecretEncrypted: null, mfaEnabled: false, mfaLastUsedStep: null },
      })
    },

    /**
     * Atomically records a TOTP time step as used. Returns false when that step (or a later one)
     * was already used — i.e. the code is a replay, even under concurrent requests.
     */
    async consumeTotpStep(id: string, step: number, enable = false): Promise<boolean> {
      const result = await db.user.updateMany({
        where: { id, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }] },
        data: { mfaLastUsedStep: step, ...(enable ? { mfaEnabled: true } : {}) },
      })
      return result.count === 1
    },
  }
}

export type UserRepository = ReturnType<typeof createUserRepository>
