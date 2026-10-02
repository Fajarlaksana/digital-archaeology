import type { Session, SessionState } from '../generated/prisma/client'
import type { Database } from '../lib/prisma'
import type { UserWithRoles } from './user.repository'

export type SessionWithUser = Session & { user: UserWithRoles }

export interface NewSession {
  tokenHash: string
  userId: string
  state: SessionState
  ipAddress: string | null
  userAgent: string | null
  now: Date
  expiresAt: Date
  reauthAt: Date | null
}

export function createSessionRepository(db: Database) {
  return {
    create(input: NewSession): Promise<Session> {
      return db.session.create({
        data: {
          tokenHash: input.tokenHash,
          userId: input.userId,
          state: input.state,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          createdAt: input.now,
          lastSeenAt: input.now,
          expiresAt: input.expiresAt,
          reauthAt: input.reauthAt,
        },
      })
    },

    /** Returns the session only if it has not been revoked. Expiry is checked by the caller. */
    findLiveByTokenHash(tokenHash: string): Promise<SessionWithUser | null> {
      return db.session.findFirst({
        where: { tokenHash, revokedAt: null },
        include: { user: { include: { roles: { orderBy: { role: 'asc' } } } } },
      })
    },

    async touch(id: string, at: Date): Promise<void> {
      await db.session.update({ where: { id }, data: { lastSeenAt: at } })
    },

    async activate(id: string, at: Date): Promise<void> {
      await db.session.update({ where: { id }, data: { state: 'ACTIVE', reauthAt: at } })
    },

    async markReauth(id: string, at: Date): Promise<void> {
      await db.session.update({ where: { id }, data: { reauthAt: at } })
    },

    async revoke(id: string, at: Date): Promise<void> {
      await db.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } })
    },

    async revokeAllForUser(userId: string, at: Date): Promise<number> {
      const result = await db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: at },
      })
      return result.count
    },
  }
}

export type SessionRepository = ReturnType<typeof createSessionRepository>
