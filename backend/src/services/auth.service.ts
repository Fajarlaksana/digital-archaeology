import { AppError } from '@da/shared'
import type { Role, SessionState } from '../generated/prisma/client'
import { permissionsFor, requiresMfa, type Permission } from '../auth/permissions'
import { verifyAgainstDummy, verifyPassword } from '../auth/password'
import type { SecretBox } from '../auth/secret-box'
import { hashSessionToken, newSessionToken } from '../auth/session-token'
import { checkTotp, newTotpSecret, totpUri } from '../auth/totp'
import { createRateLimiter } from '../lib/rate-limiter'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type { SessionRepository, SessionWithUser } from '../repositories/session.repository'
import { roleList, type UserRepository, type UserWithRoles } from '../repositories/user.repository'

export const LOCK_THRESHOLD = 10
const LOGIN_ATTEMPTS_PER_ACCOUNT = 5
const LOGIN_ATTEMPTS_PER_IP = 50
const MFA_ATTEMPTS_PER_SESSION = 5
const WINDOW_MS = 15 * 60 * 1000
/** Only write last_seen_at when it is older than this, to avoid a DB write per request. */
const TOUCH_INTERVAL_MS = 60 * 1000

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
  requestId: string
}

export interface AuthContext {
  session: SessionWithUser
  user: UserWithRoles
  roles: Role[]
  permissions: ReadonlySet<Permission>
}

export interface AuthServiceDeps {
  users: UserRepository
  sessions: SessionRepository
  audit: AuditLogRepository
  secretBox: SecretBox
  sessionTtlMs: number
  sessionIdleMs: number
  now: () => Date
}

const INVALID_LOGIN = () => new AppError('INVALID_CREDENTIALS', 'Invalid email or password')
const INVALID_MFA = () => new AppError('MFA_INVALID', 'Invalid or expired code')

export function createAuthService(deps: AuthServiceDeps) {
  const { users, sessions, audit, secretBox, now } = deps
  const clockMs = () => now().getTime()
  const accountLimiter = createRateLimiter({
    limit: LOGIN_ATTEMPTS_PER_ACCOUNT,
    windowMs: WINDOW_MS,
    now: clockMs,
  })
  const ipLimiter = createRateLimiter({
    limit: LOGIN_ATTEMPTS_PER_IP,
    windowMs: WINDOW_MS,
    now: clockMs,
  })
  const mfaLimiter = createRateLimiter({
    limit: MFA_ATTEMPTS_PER_SESSION,
    windowMs: WINDOW_MS,
    now: clockMs,
  })

  function record(
    meta: RequestMeta,
    action: string,
    result: 'SUCCESS' | 'FAILURE' | 'DENIED',
    extra: {
      userId?: string | null
      metadata?: Record<string, unknown>
    } = {},
  ) {
    return audit.create({
      action,
      result,
      userId: extra.userId ?? null,
      resourceType: 'user',
      resourceId: extra.userId ?? null,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      metadata: extra.metadata,
    })
  }

  /** Verifies a TOTP code for the user and atomically consumes its time step. */
  async function verifyAndConsumeTotp(
    user: UserWithRoles,
    code: string,
    enable: boolean,
  ): Promise<boolean> {
    if (!user.mfaSecretEncrypted) return false
    const secret = secretBox.decrypt(user.mfaSecretEncrypted)
    const check = checkTotp(secret, code, now(), user.mfaLastUsedStep)
    if (!check.valid) return false
    return users.consumeTotpStep(user.id, check.timeStep, enable)
  }

  async function failMfa(
    ctx: AuthContext,
    meta: RequestMeta,
    action: string,
    error: () => AppError = INVALID_MFA,
  ): Promise<never> {
    const key = ctx.session.id
    mfaLimiter.hit(key)
    await record(meta, action, 'FAILURE', { userId: ctx.user.id })
    if (mfaLimiter.isLimited(key)) {
      await sessions.revoke(ctx.session.id, now())
      await record(meta, 'SESSION_REVOKED_MFA_ATTEMPTS', 'DENIED', { userId: ctx.user.id })
      throw new AppError('RATE_LIMITED', 'Too many invalid codes. Please log in again.')
    }
    throw error()
  }

  return {
    async login(email: string, password: string, meta: RequestMeta) {
      const normalized = email.trim().toLowerCase()
      const accountKey = `${meta.ip ?? 'unknown'}|${normalized}`
      const ipKey = meta.ip ?? 'unknown'

      if (accountLimiter.isLimited(accountKey) || ipLimiter.isLimited(ipKey)) {
        await record(meta, 'LOGIN_RATE_LIMITED', 'DENIED', { metadata: { email: normalized } })
        throw new AppError('RATE_LIMITED', 'Too many login attempts. Try again later.')
      }

      const user = await users.findByEmail(normalized)
      const passwordOk = user
        ? await verifyPassword(user.passwordHash, password)
        : await verifyAgainstDummy(password)

      if (!user || !passwordOk || user.status !== 'ACTIVE') {
        accountLimiter.hit(accountKey)
        ipLimiter.hit(ipKey)
        let reason = !user
          ? 'unknown_email'
          : !passwordOk
            ? 'bad_password'
            : `status_${user.status}`
        if (user && !passwordOk && user.status === 'ACTIVE') {
          const status = await users.recordFailedLogin(user.id, LOCK_THRESHOLD)
          if (status === 'LOCKED') {
            reason = 'bad_password_account_locked'
            await record(meta, 'ACCOUNT_LOCKED', 'DENIED', { userId: user.id })
          }
        }
        await record(meta, 'LOGIN_FAILED', 'FAILURE', {
          userId: user?.id ?? null,
          metadata: { email: normalized, reason },
        })
        // Same message for every failure: never reveal whether the account exists or is locked.
        throw INVALID_LOGIN()
      }

      accountLimiter.reset(accountKey)
      await users.recordSuccessfulLogin(user.id, now())

      const roles = roleList(user)
      const state: SessionState = !requiresMfa(roles)
        ? 'ACTIVE'
        : user.mfaEnabled
          ? 'MFA_PENDING'
          : 'MFA_SETUP_REQUIRED'

      const token = newSessionToken()
      const issuedAt = now()
      await sessions.create({
        tokenHash: hashSessionToken(token),
        userId: user.id,
        state,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        now: issuedAt,
        expiresAt: new Date(issuedAt.getTime() + deps.sessionTtlMs),
        reauthAt: state === 'ACTIVE' ? issuedAt : null,
      })
      await record(meta, 'LOGIN_SUCCESS', 'SUCCESS', { userId: user.id, metadata: { state } })
      return { token, state }
    },

    /** Resolves a cookie token into an auth context, or null when missing/expired/revoked. */
    async resolve(token: string | undefined): Promise<AuthContext | null> {
      if (!token) return null
      const session = await sessions.findLiveByTokenHash(hashSessionToken(token))
      if (!session) return null

      const at = now()
      const idleExpired = at.getTime() - session.lastSeenAt.getTime() > deps.sessionIdleMs
      if (session.expiresAt <= at || idleExpired || session.user.status !== 'ACTIVE') {
        await sessions.revoke(session.id, at)
        return null
      }
      if (at.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        await sessions.touch(session.id, at)
      }
      const roles = roleList(session.user)
      return { session, user: session.user, roles, permissions: new Set(permissionsFor(roles)) }
    },

    async verifyMfa(ctx: AuthContext, code: string, meta: RequestMeta) {
      if (ctx.session.state !== 'MFA_PENDING') {
        throw new AppError('CONFLICT', 'This session is not waiting for an MFA code')
      }
      if (!(await verifyAndConsumeTotp(ctx.user, code, false))) {
        return failMfa(ctx, meta, 'MFA_VERIFY_FAILED')
      }
      mfaLimiter.reset(ctx.session.id)
      await sessions.activate(ctx.session.id, now())
      await record(meta, 'MFA_VERIFIED', 'SUCCESS', { userId: ctx.user.id })
    },

    async startMfaSetup(ctx: AuthContext, meta: RequestMeta) {
      if (ctx.user.mfaEnabled) throw new AppError('CONFLICT', 'MFA is already enabled')
      const secret = newTotpSecret()
      await users.setPendingMfaSecret(ctx.user.id, secretBox.encrypt(secret))
      await record(meta, 'MFA_SETUP_STARTED', 'SUCCESS', { userId: ctx.user.id })
      // The secret is shown once so it can be typed into an authenticator app manually.
      return { secret, otpauthUri: totpUri(secret, ctx.user.email) }
    },

    async enableMfa(ctx: AuthContext, code: string, meta: RequestMeta) {
      const user = await users.findById(ctx.user.id)
      if (!user) throw new AppError('UNAUTHORIZED', 'Session user no longer exists')
      if (user.mfaEnabled) throw new AppError('CONFLICT', 'MFA is already enabled')
      if (!user.mfaSecretEncrypted) throw new AppError('CONFLICT', 'Start MFA setup first')
      if (!(await verifyAndConsumeTotp(user, code, true))) {
        return failMfa({ ...ctx, user }, meta, 'MFA_ENABLE_FAILED')
      }
      mfaLimiter.reset(ctx.session.id)
      await sessions.activate(ctx.session.id, now())
      await record(meta, 'MFA_ENABLED', 'SUCCESS', { userId: user.id })
    },

    /** Re-confirms identity for sensitive actions (password, plus TOTP when MFA is enabled). */
    async reauthenticate(
      ctx: AuthContext,
      password: string,
      code: string | undefined,
      meta: RequestMeta,
    ) {
      const passwordOk = await verifyPassword(ctx.user.passwordHash, password)
      const mfaOk =
        !ctx.user.mfaEnabled ||
        (code !== undefined && (await verifyAndConsumeTotp(ctx.user, code, false)))
      if (!passwordOk || !mfaOk) {
        return failMfa(
          ctx,
          meta,
          'REAUTH_FAILED',
          () => new AppError('INVALID_CREDENTIALS', 'Invalid password or code'),
        )
      }
      mfaLimiter.reset(ctx.session.id)
      await sessions.markReauth(ctx.session.id, now())
      await record(meta, 'REAUTH_SUCCESS', 'SUCCESS', { userId: ctx.user.id })
    },

    async logout(ctx: AuthContext, meta: RequestMeta) {
      await sessions.revoke(ctx.session.id, now())
      await record(meta, 'LOGOUT', 'SUCCESS', { userId: ctx.user.id })
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
