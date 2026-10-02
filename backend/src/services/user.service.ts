import { AppError } from '@da/shared'
import type { Role, UserStatus } from '../generated/prisma/client'
import { CLI_ONLY_ROLES } from '../auth/permissions'
import { hashPassword, passwordPolicyViolation } from '../auth/password'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type { SessionRepository } from '../repositories/session.repository'
import { roleList, type UserRepository, type UserWithRoles } from '../repositories/user.repository'
import type { AuthContext, RequestMeta } from './auth.service'

export interface PublicUser {
  id: string
  email: string
  name: string
  roles: Role[]
  status: UserStatus
  mfaEnabled: boolean
  lastLoginAt: string | null
  createdAt: string
}

/** The only shape in which users leave the API: never hashes or MFA secrets. */
export function toPublicUser(user: UserWithRoles): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: roleList(user),
    status: user.status,
    mfaEnabled: user.mfaEnabled,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  }
}

function assertGrantable(roles: readonly Role[]): void {
  if (roles.length === 0) throw new AppError('VALIDATION_ERROR', 'At least one role is required')
  const cliOnly = roles.filter((role) => CLI_ONLY_ROLES.has(role))
  if (cliOnly.length > 0) {
    throw new AppError('FORBIDDEN', `${cliOnly.join(', ')} can only be granted from the server CLI`)
  }
}

export interface UserServiceDeps {
  users: UserRepository
  sessions: SessionRepository
  audit: AuditLogRepository
  now: () => Date
}

export function createUserService({ users, sessions, audit, now }: UserServiceDeps) {
  return {
    async list(): Promise<PublicUser[]> {
      return (await users.list()).map(toPublicUser)
    },

    async create(
      actor: AuthContext,
      input: { email: string; name: string; password: string; roles: Role[] },
      meta: RequestMeta,
    ): Promise<PublicUser> {
      assertGrantable(input.roles)
      const violation = passwordPolicyViolation(input.password)
      if (violation) throw new AppError('VALIDATION_ERROR', violation)

      const email = input.email.trim().toLowerCase()
      if (await users.findByEmail(email)) {
        throw new AppError('CONFLICT', 'A user with this email already exists')
      }
      const created = await users.create({
        email,
        name: input.name.trim(),
        passwordHash: await hashPassword(input.password),
        roles: [...new Set(input.roles)],
        grantedById: actor.user.id,
      })
      await audit.create({
        action: 'USER_CREATED',
        result: 'SUCCESS',
        userId: actor.user.id,
        resourceType: 'user',
        resourceId: created.id,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        metadata: { email, roles: roleList(created) },
      })
      return toPublicUser(created)
    },

    async update(
      actor: AuthContext,
      id: string,
      input: { name?: string; roles?: Role[]; status?: UserStatus },
      meta: RequestMeta,
    ): Promise<PublicUser> {
      const target = await users.findById(id)
      if (!target) throw new AppError('NOT_FOUND', 'User not found', { resourceId: id })

      const changesAccess = input.roles !== undefined || input.status !== undefined
      if (changesAccess && target.id === actor.user.id) {
        throw new AppError('FORBIDDEN', 'You cannot change your own roles or status')
      }
      if (roleList(target).some((role) => CLI_ONLY_ROLES.has(role))) {
        throw new AppError(
          'FORBIDDEN',
          'SUPER_ADMIN accounts can only be managed from the server CLI',
          {
            resourceId: id,
          },
        )
      }
      if (input.roles !== undefined) assertGrantable(input.roles)

      const before = { roles: roleList(target), status: target.status, name: target.name }
      const updated = await users.update(id, {
        name: input.name?.trim(),
        status: input.status,
        roles: input.roles ? [...new Set(input.roles)] : undefined,
        grantedById: actor.user.id,
      })
      // Access changed: force a fresh login so new roles / MFA requirements apply immediately.
      const revokedSessions = changesAccess ? await sessions.revokeAllForUser(id, now()) : 0

      await audit.create({
        action: 'USER_UPDATED',
        result: 'SUCCESS',
        userId: actor.user.id,
        resourceType: 'user',
        resourceId: id,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
        metadata: {
          before,
          after: { roles: roleList(updated), status: updated.status, name: updated.name },
          revokedSessions,
        },
      })
      return toPublicUser(updated)
    },
  }
}

export type UserService = ReturnType<typeof createUserService>
