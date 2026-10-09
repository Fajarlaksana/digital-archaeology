import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Role } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, type Harness } from './harness'

const testDatabaseUrl = inject('testDatabaseUrl')

const MFA_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'REVIEWER'])
const newUserBody = (roles: Role[]) => ({
  email: `new-${Math.random().toString(36).slice(2)}@test.local`,
  name: 'New User',
  password: 'a long enough password',
  roles,
})

describe.skipIf(!testDatabaseUrl)('user management & RBAC', () => {
  let db: Database
  let h: Harness

  beforeAll(() => {
    db = createPrismaClient(testDatabaseUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })
  afterEach(async () => {
    await h?.app.close()
  })

  async function sessionFor(roles: Role[]) {
    const user = await h.createUser(roles, { mfa: roles.some((r) => MFA_ROLES.has(r)) })
    return { user, token: await h.activeSession(user) }
  }

  describe('role × endpoint matrix', () => {
    const matrix: Array<[Role, { list: number; create: number }]> = [
      ['SUPER_ADMIN', { list: 403, create: 403 }],
      ['ADMIN', { list: 200, create: 201 }],
      ['ANALYST', { list: 403, create: 403 }],
      ['REVIEWER', { list: 403, create: 403 }],
      ['AUDITOR', { list: 200, create: 403 }],
    ]

    it.each(matrix)('%s → GET /api/users %j', async (role, expected) => {
      h = await createHarness(db)
      const { token } = await sessionFor([role])
      expect((await h.call('GET', '/api/users', token)).statusCode).toBe(expected.list)
      const created = await h.call('POST', '/api/users', token, newUserBody(['ANALYST']))
      expect(created.statusCode).toBe(expected.create)
    })

    it('anonymous requests get 401', async () => {
      h = await createHarness(db)
      expect((await h.call('GET', '/api/users')).statusCode).toBe(401)
      expect(
        (await h.call('POST', '/api/users', undefined, newUserBody(['ANALYST']))).statusCode,
      ).toBe(401)
    })

    it('denied attempts are audited', async () => {
      h = await createHarness(db)
      const { user, token } = await sessionFor(['ANALYST'])
      await h.call('GET', '/api/users', token)
      const denied = await db.auditLog.findFirst({
        where: { userId: user.id, action: 'ACCESS_DENIED' },
      })
      expect(denied).toMatchObject({ result: 'DENIED', resourceId: 'users:read' })
    })
  })

  describe('ADMIN rules', () => {
    it('creates a user with a hashed password and returns no secrets', async () => {
      h = await createHarness(db)
      const { token } = await sessionFor(['ADMIN'])
      const body = newUserBody(['ANALYST', 'AUDITOR'])
      const res = await h.call('POST', '/api/users', token, body)

      expect(res.statusCode).toBe(201)
      expect(res.json().user).toMatchObject({ email: body.email, roles: ['ANALYST', 'AUDITOR'] })
      expect(res.body).not.toContain(body.password)
      expect(res.body).not.toMatch(/passwordHash|mfaSecret/)
      const stored = await db.user.findUniqueOrThrow({ where: { email: body.email } })
      expect(stored.passwordHash).toMatch(/^\$argon2id\$/)
    })

    it('cannot create SUPER_ADMIN through the API', async () => {
      h = await createHarness(db)
      const { token } = await sessionFor(['ADMIN'])
      const res = await h.call('POST', '/api/users', token, newUserBody(['SUPER_ADMIN']))
      expect(res.statusCode).toBe(403)
      expect(res.json().error.message).toMatch(/server CLI/)
    })

    it('cannot grant SUPER_ADMIN to an existing user', async () => {
      h = await createHarness(db)
      const { token } = await sessionFor(['ADMIN'])
      const target = await h.createUser(['ANALYST'])
      const res = await h.call('PATCH', `/api/users/${target.id}`, token, {
        roles: ['SUPER_ADMIN'],
      })
      expect(res.statusCode).toBe(403)
    })

    it('cannot modify a SUPER_ADMIN account', async () => {
      h = await createHarness(db)
      const { token } = await sessionFor(['ADMIN'])
      const superAdmin = await h.createUser(['SUPER_ADMIN'], { mfa: true })
      const res = await h.call('PATCH', `/api/users/${superAdmin.id}`, token, {
        status: 'DISABLED',
      })
      expect(res.statusCode).toBe(403)
    })

    it('cannot change its own roles or status', async () => {
      h = await createHarness(db)
      const { user, token } = await sessionFor(['ADMIN'])
      const res = await h.call('PATCH', `/api/users/${user.id}`, token, {
        roles: ['ADMIN', 'REVIEWER'],
      })
      expect(res.statusCode).toBe(403)
    })

    it('rejects weak passwords and duplicate emails', async () => {
      h = await createHarness(db)
      const { token } = await sessionFor(['ADMIN'])
      const weak = await h.call('POST', '/api/users', token, {
        ...newUserBody(['ANALYST']),
        password: 'short',
      })
      expect(weak.json().error.code).toBe('VALIDATION_ERROR')

      const body = newUserBody(['ANALYST'])
      await h.call('POST', '/api/users', token, body)
      const dup = await h.call('POST', '/api/users', token, {
        ...body,
        email: body.email.toUpperCase(),
      })
      expect(dup.statusCode).toBe(409)
    })

    it('changing roles revokes the target user’s sessions', async () => {
      h = await createHarness(db)
      const { token: adminToken } = await sessionFor(['ADMIN'])
      const target = await h.createUser(['ANALYST'])
      const targetToken = await h.activeSession(target)
      expect((await h.call('GET', '/api/auth/me', targetToken)).statusCode).toBe(200)

      const res = await h.call('PATCH', `/api/users/${target.id}`, adminToken, {
        roles: ['AUDITOR'],
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().user.roles).toEqual(['AUDITOR'])
      expect((await h.call('GET', '/api/auth/me', targetToken)).statusCode).toBe(401)
    })

    it('re-activating a locked user resets the failure counter', async () => {
      h = await createHarness(db)
      const { token } = await sessionFor(['ADMIN'])
      const target = await h.createUser(['ANALYST'])
      await db.user.update({
        where: { id: target.id },
        data: { status: 'LOCKED', failedLoginCount: 10 },
      })

      const res = await h.call('PATCH', `/api/users/${target.id}`, token, { status: 'ACTIVE' })
      expect(res.statusCode).toBe(200)
      const stored = await db.user.findUniqueOrThrow({ where: { id: target.id } })
      expect(stored).toMatchObject({ status: 'ACTIVE', failedLoginCount: 0 })
      expect((await h.login(target.email)).res.statusCode).toBe(200)
    })

    it('writes before/after to the audit log for role changes', async () => {
      h = await createHarness(db)
      const { user: admin, token } = await sessionFor(['ADMIN'])
      const target = await h.createUser(['ANALYST'])
      await h.call('PATCH', `/api/users/${target.id}`, token, { roles: ['REVIEWER'] })

      const entry = await db.auditLog.findFirst({
        where: { userId: admin.id, action: 'USER_UPDATED', resourceId: target.id },
      })
      expect(entry?.metadata).toMatchObject({
        before: { roles: ['ANALYST'] },
        after: { roles: ['REVIEWER'] },
      })
    })
  })

  describe('MFA reset (lost authenticator, Phase 13b)', () => {
    const reset = (
      id: string,
      token: string,
      body: object = { reason: 'Identity verified by video call + ID card' },
    ) => h.call('POST', `/api/users/${id}/mfa/reset`, token, body)

    it('ADMIN resets another user: sessions end, MFA set-up is required again, audited', async () => {
      h = await createHarness(db)
      const { user: admin, token } = await sessionFor(['ADMIN'])
      const { user: target, token: targetToken } = await sessionFor(['REVIEWER'])

      const res = await reset(target.id, token)
      expect(res.statusCode).toBe(200)
      expect(res.json().user).toMatchObject({ id: target.id, mfaEnabled: false })
      const stored = await db.user.findUniqueOrThrow({ where: { id: target.id } })
      expect(stored).toMatchObject({
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        mfaLastUsedStep: null,
      })
      expect((await h.call('GET', '/api/auth/me', targetToken)).statusCode).toBe(401)

      const relogin = await h.login(target.email)
      expect(relogin.res.json()).toMatchObject({ sessionState: 'MFA_SETUP_REQUIRED' })

      const audit = await db.auditLog.findFirst({
        where: { userId: admin.id, action: 'MFA_RESET' },
      })
      expect(audit).toMatchObject({ resourceId: target.id })
      expect(audit?.metadata).toMatchObject({ reason: 'Identity verified by video call + ID card' })
    })

    it('needs a reason, a recent re-auth, and refuses self, SUPER_ADMIN and users without MFA', async () => {
      h = await createHarness(db)
      const { user: admin, token } = await sessionFor(['ADMIN'])
      const { user: target } = await sessionFor(['REVIEWER'])
      expect((await reset(target.id, token, { reason: 'short' })).statusCode).toBe(400)
      expect((await reset(admin.id, token)).statusCode).toBe(403)
      const { user: superAdmin } = await sessionFor(['SUPER_ADMIN'])
      const sa = await reset(superAdmin.id, token)
      expect(sa.statusCode).toBe(403)
      expect(sa.json().error.message).toMatch(/server CLI/)
      const { user: analyst } = await sessionFor(['ANALYST'])
      expect((await reset(analyst.id, token)).statusCode).toBe(409)
      expect((await reset(randomUUID(), token)).statusCode).toBe(404)

      h.advance(6 * 60_000)
      const stale = await reset(target.id, token)
      expect(stale.json().error.code).toBe('REAUTH_REQUIRED')
      expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).mfaEnabled).toBe(true)
    })

    it.each(['SUPER_ADMIN', 'ANALYST', 'REVIEWER', 'AUDITOR'] as const)(
      '%s cannot reset MFA (403)',
      async (role) => {
        h = await createHarness(db)
        const { user: target } = await sessionFor(['REVIEWER'])
        const { token } = await sessionFor([role])
        expect((await reset(target.id, token)).statusCode).toBe(403)
      },
    )
  })
})
