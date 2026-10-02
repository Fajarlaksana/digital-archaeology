import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { LOCK_THRESHOLD } from '../../../src/services/auth.service'
import { APP_ORIGIN, PASSWORD, createHarness, type Harness } from './harness'

const testDatabaseUrl = inject('testDatabaseUrl')

describe.skipIf(!testDatabaseUrl)('authentication', () => {
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

  describe('login', () => {
    it('starts an ACTIVE session for a role without mandatory MFA', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      const { res, token } = await h.login(user.email)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ sessionState: 'ACTIVE' })
      const cookie = res.cookies.find((c) => c.name === 'da_session')
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' })
      expect(res.headers['cache-control']).toBe('no-store')

      const me = await h.call('GET', '/api/auth/me', token)
      expect(me.statusCode).toBe(200)
      expect(me.json()).toMatchObject({
        user: { email: user.email, roles: ['ANALYST'], mfaEnabled: false },
        sessionState: 'ACTIVE',
      })
      expect(me.json().permissions).toContain('scans:run')
    })

    it('stores only a hash of the session token', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      const { token } = await h.login(user.email)
      const rows = await db.session.findMany({ where: { userId: user.id } })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.tokenHash).not.toBe(token)
      expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('gives the same answer for a wrong password and an unknown email', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      const wrong = await h.login(user.email, 'wrong password!!')
      const unknown = await h.login('nobody@test.local', PASSWORD)

      for (const { res, token } of [wrong, unknown]) {
        expect(res.statusCode).toBe(401)
        expect(res.json().error).toMatchObject({
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        })
        expect(token).toBeUndefined()
      }
    })

    it('treats email case-insensitively', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      expect((await h.login(user.email.toUpperCase())).res.statusCode).toBe(200)
    })

    it('rate-limits after 5 failures per IP+email, even with the right password', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      for (let i = 0; i < 5; i++) await h.login(user.email, 'wrong password!!')

      const blocked = await h.login(user.email)
      expect(blocked.res.statusCode).toBe(429)
      expect(blocked.res.json().error.code).toBe('RATE_LIMITED')

      h.advance(15 * 60_000 + 1)
      expect((await h.login(user.email)).res.statusCode).toBe(200)
    })

    it(`locks the account after ${LOCK_THRESHOLD} failures and hides that from the client`, async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      for (let i = 0; i < LOCK_THRESHOLD; i++) {
        await h.login(user.email, 'wrong password!!', `10.1.0.${i}`) // spread IPs: test the lock, not the rate limit
      }
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('LOCKED')

      const { res } = await h.login(user.email, PASSWORD, '10.2.0.1')
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS')

      const lockEvent = await db.auditLog.findFirst({
        where: { userId: user.id, action: 'ACCOUNT_LOCKED' },
      })
      expect(lockEvent).not.toBeNull()
    })

    it('never writes the password to logs, audit metadata or responses', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      await h.login(user.email, 'wrong-but-secret-password-123')
      const { token } = await h.login(user.email)
      const me = await h.call('GET', '/api/auth/me', token)

      const audits = await db.auditLog.findMany({ where: { userId: user.id } })
      const auditJson = JSON.stringify(audits, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      )
      const everything = h.logs() + auditJson + me.body
      expect(everything).not.toContain('wrong-but-secret-password-123')
      expect(everything).not.toContain(PASSWORD)
      expect(me.body).not.toMatch(/passwordHash|mfaSecret/)
    })
  })

  describe('MFA', () => {
    it('forces MFA setup for an ADMIN without MFA, then grants access', async () => {
      h = await createHarness(db)
      const admin = await h.createUser(['ADMIN'])
      const { res, token } = await h.login(admin.email)
      expect(res.json().sessionState).toBe('MFA_SETUP_REQUIRED')

      const blocked = await h.call('GET', '/api/users', token)
      expect(blocked.statusCode).toBe(403)
      expect(blocked.json().error.code).toBe('MFA_SETUP_REQUIRED')

      const setup = await h.call('POST', '/api/auth/mfa/setup', token, {})
      expect(setup.statusCode).toBe(200)
      const { secret, otpauthUri } = setup.json()
      expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/Digital%20Archaeology:/)

      const stored = await db.user.findUniqueOrThrow({ where: { id: admin.id } })
      expect(stored.mfaSecretEncrypted).not.toContain(secret)

      const bad = await h.call('POST', '/api/auth/mfa/enable', token, { code: '000000' })
      expect(bad.statusCode).toBe(401)

      const enable = await h.call('POST', '/api/auth/mfa/enable', token, { code: h.code(secret) })
      expect(enable.statusCode).toBe(200)
      expect((await h.call('GET', '/api/users', token)).statusCode).toBe(200)
    })

    it('requires the TOTP code when MFA is enabled', async () => {
      h = await createHarness(db)
      const reviewer = await h.createUser(['REVIEWER'], { mfa: true })
      const { res, token } = await h.login(reviewer.email)
      expect(res.json().sessionState).toBe('MFA_PENDING')

      const me = await h.call('GET', '/api/auth/me', token)
      expect(me.json().permissions).toContain('transactions:approve')
      const denied = await h.call('GET', '/api/users', token)
      expect(denied.json().error.code).toBe('MFA_REQUIRED')

      // A pending session must not be able to re-enrol a new authenticator.
      expect((await h.call('POST', '/api/auth/mfa/setup', token, {})).statusCode).toBe(403)

      const ok = await h.call('POST', '/api/auth/mfa/verify', token, {
        code: h.code(reviewer.secret!),
      })
      expect(ok.statusCode).toBe(200)
      expect((await h.call('GET', '/api/auth/me', token)).json().sessionState).toBe('ACTIVE')
    })

    it('rejects a replayed TOTP code', async () => {
      h = await createHarness(db)
      const reviewer = await h.createUser(['REVIEWER'], { mfa: true })
      const code = h.code(reviewer.secret!)

      const first = await h.login(reviewer.email)
      expect((await h.call('POST', '/api/auth/mfa/verify', first.token, { code })).statusCode).toBe(
        200,
      )

      h.advance(5_000) // same 30-second window
      const second = await h.login(reviewer.email)
      const replay = await h.call('POST', '/api/auth/mfa/verify', second.token, { code })
      expect(replay.statusCode).toBe(401)
      expect(replay.json().error.code).toBe('MFA_INVALID')
    })

    it('revokes the session after 5 wrong codes', async () => {
      h = await createHarness(db)
      const reviewer = await h.createUser(['REVIEWER'], { mfa: true })
      const { token } = await h.login(reviewer.email)
      let last
      for (let i = 0; i < 5; i++) {
        last = await h.call('POST', '/api/auth/mfa/verify', token, { code: '000000' })
      }
      expect(last?.statusCode).toBe(429)
      expect((await h.call('GET', '/api/auth/me', token)).statusCode).toBe(401)
    })
  })

  describe('sessions', () => {
    it('logout revokes the session server-side', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      const { token } = await h.login(user.email)
      expect((await h.call('POST', '/api/auth/logout', token, {})).statusCode).toBe(204)
      expect((await h.call('GET', '/api/auth/me', token)).statusCode).toBe(401)
    })

    it('expires after 30 minutes of inactivity', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      const { token } = await h.login(user.email)
      h.advance(29 * 60_000)
      expect((await h.call('GET', '/api/auth/me', token)).statusCode).toBe(200)
      h.advance(31 * 60_000)
      expect((await h.call('GET', '/api/auth/me', token)).statusCode).toBe(401)
    })

    it('expires after 12 hours even when active', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      const { token } = await h.login(user.email)
      for (let i = 0; i < 25; i++) {
        h.advance(29 * 60_000)
        await h.call('GET', '/api/auth/me', token)
      }
      expect((await h.call('GET', '/api/auth/me', token)).statusCode).toBe(401)
    })

    it('re-authentication checks the password and records the time', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      const { token } = await h.login(user.email)
      h.advance(10 * 60_000)

      const bad = await h.call('POST', '/api/auth/reauth', token, { password: 'not my password' })
      expect(bad.json().error.code).toBe('INVALID_CREDENTIALS')

      expect(
        (await h.call('POST', '/api/auth/reauth', token, { password: PASSWORD })).statusCode,
      ).toBe(204)
      expect((await h.call('GET', '/api/auth/me', token)).json().reauthAt).toBe(
        h.now().toISOString(),
      )
    })
  })

  describe('CSRF hardening', () => {
    it('rejects state-changing requests from another origin', async () => {
      h = await createHarness(db)
      const user = await h.createUser(['ANALYST'])
      const { token } = await h.login(user.email)
      const res = await h.call(
        'POST',
        '/api/auth/logout',
        token,
        {},
        { origin: 'https://evil.example' },
      )
      expect(res.statusCode).toBe(403)
      const ok = await h.call('POST', '/api/auth/logout', token, {}, { origin: APP_ORIGIN })
      expect(ok.statusCode).toBe(204)
    })

    it('rejects text/plain bodies (cannot be sent by a cross-site form as JSON)', async () => {
      h = await createHarness(db)
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify({ email: 'a@b.c', password: 'x' }),
      })
      expect(res.statusCode).toBe(415)
    })
  })
})
