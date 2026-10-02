import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  clearSessionCookie,
  requestMeta,
  setSessionCookie,
  type AuthPluginOptions,
  type Guards,
} from '../auth/plugin'
import type { AuthContext, AuthService } from '../services/auth.service'
import { toPublicUser } from '../services/user.service'

const loginBody = z.object({
  email: z.string().trim().max(254),
  password: z.string().min(1).max(256),
})
const codeBody = z.object({ code: z.string().regex(/^\d{6}$/, 'must be a 6-digit code') })
const reauthBody = z.object({
  password: z.string().min(1).max(256),
  code: z
    .string()
    .regex(/^\d{6}$/, 'must be a 6-digit code')
    .optional(),
})

const ownAudit = { config: { skipGenericAudit: true } }

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; guards: Guards; cookie: AuthPluginOptions },
): void {
  const { auth, guards } = deps
  const anyState = guards.session('ACTIVE', 'MFA_PENDING', 'MFA_SETUP_REQUIRED')

  // Auth responses may carry secrets (MFA enrolment) — never cache them.
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/auth/')) reply.header('cache-control', 'no-store')
  })

  app.post('/api/auth/login', ownAudit, async (request, reply) => {
    const body = loginBody.parse(request.body)
    const { token, state } = await auth.login(body.email, body.password, requestMeta(request))
    setSessionCookie(reply, token, deps.cookie)
    return { sessionState: state }
  })

  app.post('/api/auth/logout', { ...ownAudit, preHandler: anyState }, async (request, reply) => {
    await auth.logout(request.auth as AuthContext, requestMeta(request))
    clearSessionCookie(reply, deps.cookie)
    return reply.status(204).send()
  })

  app.get('/api/auth/me', { preHandler: anyState }, async (request) => {
    const ctx = request.auth as AuthContext
    return {
      user: toPublicUser(ctx.user),
      sessionState: ctx.session.state,
      permissions: [...ctx.permissions],
      reauthAt: ctx.session.reauthAt?.toISOString() ?? null,
    }
  })

  app.post(
    '/api/auth/mfa/setup',
    { ...ownAudit, preHandler: guards.session('MFA_SETUP_REQUIRED', 'ACTIVE') },
    async (request) => auth.startMfaSetup(request.auth as AuthContext, requestMeta(request)),
  )

  app.post(
    '/api/auth/mfa/enable',
    { ...ownAudit, preHandler: guards.session('MFA_SETUP_REQUIRED', 'ACTIVE') },
    async (request) => {
      const { code } = codeBody.parse(request.body)
      await auth.enableMfa(request.auth as AuthContext, code, requestMeta(request))
      return { sessionState: 'ACTIVE' }
    },
  )

  app.post(
    '/api/auth/mfa/verify',
    { ...ownAudit, preHandler: guards.session('MFA_PENDING') },
    async (request) => {
      const { code } = codeBody.parse(request.body)
      await auth.verifyMfa(request.auth as AuthContext, code, requestMeta(request))
      return { sessionState: 'ACTIVE' }
    },
  )

  app.post(
    '/api/auth/reauth',
    { ...ownAudit, preHandler: guards.session('ACTIVE') },
    async (request, reply) => {
      const body = reauthBody.parse(request.body)
      await auth.reauthenticate(
        request.auth as AuthContext,
        body.password,
        body.code,
        requestMeta(request),
      )
      return reply.status(204).send()
    },
  )
}
