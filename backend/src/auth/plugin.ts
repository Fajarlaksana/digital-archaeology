import cookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError, type Logger } from '@da/shared'
import type { SessionState } from '../generated/prisma/client'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type { AuthContext, AuthService, RequestMeta } from '../services/auth.service'
import type { Permission } from './permissions'
import { SESSION_COOKIE } from './session-token'

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
  interface FastifyContextConfig {
    /** Route writes its own, more specific audit events (e.g. auth routes). */
    skipGenericAudit?: boolean
    /** Intentionally reachable without a session (login, health). Checked by the route inventory test. */
    public?: boolean
  }
}

/** Marks guard functions so the route inventory can tell which protection a route has (Phase 13). */
export const GUARD = Symbol('guard')
export type GuardMark =
  | { kind: 'session'; states: SessionState[] }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'recentAuth'; maxAgeMs: number }

function mark<T extends object>(fn: T, info: GuardMark): T {
  return Object.assign(fn, { [GUARD]: info })
}

/** The guard marks found in a route's preHandler option (function or array). */
export function guardsOf(preHandler: unknown): GuardMark[] {
  const list = Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : []
  return list.flatMap((fn) => {
    const info = (fn as { [GUARD]?: GuardMark })[GUARD]
    return info ? [info] : []
  })
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface AuthPluginOptions {
  auth: AuthService
  audit: AuditLogRepository
  logger: Logger
  appOrigin: string
  cookieSecure: boolean
  sessionTtlMs: number
  now: () => Date
}

export function requestMeta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent']?.slice(0, 512) ?? null,
    requestId: request.id,
  }
}

export async function registerAuth(
  app: FastifyInstance,
  options: AuthPluginOptions,
): Promise<void> {
  await app.register(cookie)
  app.decorateRequest('auth', null)

  // Only JSON bodies: a cross-site HTML form cannot send application/json (CSRF hardening).
  app.removeContentTypeParser('text/plain')

  app.addHook('onRequest', async (request) => {
    if (MUTATING.has(request.method)) {
      const origin = request.headers.origin
      if (origin !== undefined && origin !== new URL(options.appOrigin).origin) {
        throw new AppError('FORBIDDEN', 'Cross-origin request rejected')
      }
    }
    request.auth = await options.auth.resolve(request.cookies[SESSION_COOKIE])
  })

  // Generic audit trail for every state-changing request (no bodies — they may hold secrets).
  app.addHook('onResponse', async (request, reply) => {
    if (!MUTATING.has(request.method) || request.routeOptions.config.skipGenericAudit) return
    const status = reply.statusCode
    try {
      const params = request.params as Record<string, string> | undefined
      await options.audit.create({
        action: `${request.method} ${request.routeOptions.url ?? 'unknown-route'}`,
        result: status < 400 ? 'SUCCESS' : status === 401 || status === 403 ? 'DENIED' : 'FAILURE',
        userId: request.auth?.user.id ?? null,
        resourceType: 'http',
        resourceId: params?.id ?? null,
        ...requestMeta(request),
        metadata: { statusCode: status },
      })
    } catch (err) {
      options.logger.error({ err }, 'AUDIT_WRITE_FAILED')
    }
  })
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  options: AuthPluginOptions,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: options.cookieSecure,
    path: '/',
    maxAge: Math.floor(options.sessionTtlMs / 1000),
  })
}

export function clearSessionCookie(reply: FastifyReply, options: AuthPluginOptions): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: options.cookieSecure,
    path: '/',
  })
}

/** Route guards. Use as `preHandler`. */
export function createGuards({ audit, now }: Pick<AuthPluginOptions, 'audit' | 'now'>) {
  function session(...allowed: SessionState[]) {
    const states: SessionState[] = allowed.length > 0 ? allowed : ['ACTIVE']
    return mark(
      async (request: FastifyRequest): Promise<void> => {
        const ctx = request.auth
        if (!ctx) throw new AppError('UNAUTHORIZED', 'Authentication required')
        if (!states.includes(ctx.session.state)) {
          if (ctx.session.state === 'MFA_PENDING') {
            throw new AppError('MFA_REQUIRED', 'Enter your authenticator code to continue')
          }
          if (ctx.session.state === 'MFA_SETUP_REQUIRED') {
            throw new AppError('MFA_SETUP_REQUIRED', 'Set up two-factor authentication to continue')
          }
          throw new AppError('FORBIDDEN', 'Not allowed in the current session state')
        }
      },
      { kind: 'session', states },
    )
  }

  const activeSession = session('ACTIVE')

  function permission(required: Permission) {
    return mark(
      async (request: FastifyRequest): Promise<void> => {
        await activeSession(request)
        const ctx = request.auth as AuthContext
        if (!ctx.permissions.has(required)) {
          await audit.create({
            action: 'ACCESS_DENIED',
            result: 'DENIED',
            userId: ctx.user.id,
            resourceType: 'permission',
            resourceId: required,
            ...requestMeta(request),
            metadata: { route: request.routeOptions.url, method: request.method, roles: ctx.roles },
          })
          throw new AppError('FORBIDDEN', 'You do not have permission for this action')
        }
      },
      { kind: 'permission', permission: required },
    )
  }

  /** Sensitive actions require the user to have re-entered credentials within `maxAgeMs`. */
  function recentAuth(maxAgeMs: number) {
    return mark(
      async (request: FastifyRequest): Promise<void> => {
        await activeSession(request)
        const reauthAt = (request.auth as AuthContext).session.reauthAt
        if (!reauthAt || now().getTime() - reauthAt.getTime() > maxAgeMs) {
          throw new AppError('REAUTH_REQUIRED', 'Please confirm your password to continue')
        }
      },
      { kind: 'recentAuth', maxAgeMs },
    )
  }

  return { session, permission, recentAuth }
}

export type Guards = ReturnType<typeof createGuards>
