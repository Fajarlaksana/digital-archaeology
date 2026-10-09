import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Role, UserStatus } from '../generated/prisma/enums'
import { requestMeta, type Guards } from '../auth/plugin'
import type { AuthContext } from '../services/auth.service'
import type { UserService } from '../services/user.service'

const createBody = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(120),
  password: z.string().max(256),
  roles: z.array(z.enum(Role)).min(1).max(5),
})

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    roles: z.array(z.enum(Role)).min(1).max(5).optional(),
    status: z.enum(UserStatus).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update')

const idParams = z.object({ id: z.uuid() })
/** How the person's identity was verified out of band (e.g. video call + ID card). */
const resetMfaBody = z.object({ reason: z.string().trim().min(10).max(500) })

/** Resetting someone's MFA is account recovery: re-confirm identity first (ADR-027). */
export const MFA_RESET_REAUTH_WINDOW_MS = 5 * 60_000

export function registerUserRoutes(
  app: FastifyInstance,
  deps: { users: UserService; guards: Guards },
): void {
  const { users, guards } = deps

  app.get('/api/users', { preHandler: guards.permission('users:read') }, async () => ({
    users: await users.list(),
  }))

  app.post(
    '/api/users',
    { preHandler: guards.permission('users:manage') },
    async (request, reply) => {
      const body = createBody.parse(request.body)
      const user = await users.create(request.auth as AuthContext, body, requestMeta(request))
      return reply.status(201).send({ user })
    },
  )

  app.post(
    '/api/users/:id/mfa/reset',
    {
      config: { skipGenericAudit: true },
      preHandler: [
        guards.permission('users:manage'),
        guards.recentAuth(MFA_RESET_REAUTH_WINDOW_MS),
      ],
    },
    async (request) => {
      const { id } = idParams.parse(request.params)
      return {
        user: await users.resetMfa(
          request.auth as AuthContext,
          id,
          resetMfaBody.parse(request.body),
          requestMeta(request),
        ),
      }
    },
  )

  app.patch(
    '/api/users/:id',
    { preHandler: guards.permission('users:manage') },
    async (request) => {
      const { id } = idParams.parse(request.params)
      const body = updateBody.parse(request.body)
      return {
        user: await users.update(request.auth as AuthContext, id, body, requestMeta(request)),
      }
    },
  )
}
