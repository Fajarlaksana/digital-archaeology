import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { createLogger } from '@da/shared'
import { buildApp, type RouteInfo } from '../../../src/app'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { APP_ORIGIN, createHarness, type Harness } from '../auth/harness'

const testDatabaseUrl = inject('testDatabaseUrl')

/** The ONLY /api routes that may be called without a session. */
const PUBLIC_API = new Set(['POST /api/auth/login'])
/** Session-only (no permission) is acceptable for the user's own auth flow, nothing else. */
const SESSION_ONLY_PREFIX = '/api/auth/'
/**
 * Actions that must ALSO require a recent re-authentication (password + TOTP ≤ 5 min):
 * everything that touches the vault, decides where assets go, or signs/sends them.
 */
const NEEDS_RECENT_AUTH = [
  'POST /api/vault/init',
  'POST /api/vault/unlock',
  'POST /api/vault/passphrase',
  'POST /api/vault/recover',
  'POST /api/vault/keys',
  'POST /api/vault/keys/reveal',
  'POST /api/challenges/:id/vault-signature',
  'POST /api/destinations/:id/approve',
  'POST /api/destinations/:id/reject',
  'POST /api/destinations/:id/disable',
  'POST /api/transactions/:id/approve',
  'POST /api/transactions/:id/reject',
  'POST /api/transactions/:id/sign',
  'POST /api/transactions/:id/broadcast',
]

const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`
const concrete = (url: string) => url.replace(/:[a-zA-Z]+/g, () => randomUUID())
const MARKER = 'FUZZ_7f3c'

describe.skipIf(!testDatabaseUrl)('security (SA 17)', () => {
  let db: Database
  let h: Harness
  let api: RouteInfo[]

  beforeAll(() => {
    db = createPrismaClient(testDatabaseUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })
  afterEach(async () => {
    await h?.app.close()
  })

  async function harness() {
    h = await createHarness(db)
    api = h.app.routeInventory.filter((r) => r.url.startsWith('/api/'))
    return h
  }

  describe('authentication & authorization coverage (route inventory)', () => {
    it('every API route is protected; only login is public', async () => {
      await harness()
      expect(api.length).toBeGreaterThan(60)
      const unprotected = api.filter((r) => r.guards.length === 0 && !r.public).map(key)
      expect(unprotected).toEqual([])
      expect(api.filter((r) => r.public).map(key)).toEqual([...PUBLIC_API])
    })

    it('outside the auth flow, every route checks a PERMISSION (not just a session)', async () => {
      await harness()
      const sessionOnly = api
        .filter((r) => !r.public && !r.url.startsWith(SESSION_ONLY_PREFIX))
        .filter((r) => !r.guards.some((g) => g.kind === 'permission'))
        .map(key)
      expect(sessionOnly).toEqual([])
    })

    it('vault, destination, approval, signing and broadcast actions also need a recent re-auth', async () => {
      await harness()
      const byKey = new Map(api.map((r) => [key(r), r]))
      for (const route of NEEDS_RECENT_AUTH) {
        const info = byKey.get(route)
        expect(info, route).toBeDefined()
        expect(
          info!.guards.some((g) => g.kind === 'recentAuth' && g.maxAgeMs <= 5 * 60_000),
          route,
        ).toBe(true)
      }
      // ...and only SUPER_ADMIN-level permissions guard the vault itself.
      for (const r of api.filter((x) => x.url.startsWith('/api/vault'))) {
        expect(
          r.guards.find((g) => g.kind === 'permission'),
          key(r),
        ).toMatchObject({
          permission: 'vault:manage',
        })
      }
    })

    it('every protected route answers 401 to an anonymous request', async () => {
      await harness()
      const failures: string[] = []
      for (const r of api.filter((x) => !x.public)) {
        const res = await h.call(
          r.method as 'GET',
          concrete(r.url),
          undefined,
          r.method === 'GET' ? undefined : {},
        )
        if (res.statusCode !== 401) failures.push(`${key(r)} → ${res.statusCode}`)
      }
      expect(failures).toEqual([])
    })
  })

  describe('input validation', () => {
    it('malformed bodies on every mutating route give 4xx — never 500, never an echo of the input', async () => {
      await harness()
      const user = await h.createUser(['SUPER_ADMIN', 'ADMIN', 'ANALYST', 'REVIEWER', 'AUDITOR'], {
        mfa: true,
      })
      const token = await h.activeSession(user)
      // The auth flow itself is exercised in auth.test.ts (logout/re-auth would end this session).
      const targets = api.filter(
        (r) => ['POST', 'PATCH'].includes(r.method) && !r.url.startsWith(SESSION_ONLY_PREFIX),
      )
      const payloads: Array<{ body: string; type?: string }> = [
        { body: JSON.stringify([MARKER]) },
        { body: JSON.stringify(MARKER) },
        { body: JSON.stringify({ [MARKER]: MARKER, networkId: MARKER, amount: `-1${MARKER}` }) },
        { body: `{"${MARKER}":` },
        { body: MARKER, type: 'text/plain' },
        { body: JSON.stringify({ x: MARKER.repeat(200_000) }) },
      ]
      expect(targets.length).toBeGreaterThan(35)
      const failures: string[] = []
      for (const r of targets) {
        for (const p of payloads) {
          const res = await h.app.inject({
            method: r.method as 'POST',
            url: concrete(r.url),
            headers: {
              cookie: `da_session=${token}`,
              origin: APP_ORIGIN,
              'content-type': p.type ?? 'application/json',
            },
            payload: p.body,
          })
          if (res.statusCode >= 500 || res.body.includes(MARKER)) {
            failures.push(`${key(r)} [${p.body.slice(0, 20)}] → ${res.statusCode}`)
          }
        }
      }
      expect(failures).toEqual([])
    })
  })

  describe('headers & cross-origin', () => {
    it('sets strict security headers on API and health responses', async () => {
      await harness()
      for (const url of ['/health', '/api/auth/me']) {
        const res = await h.app.inject({ method: 'GET', url })
        expect(res.headers['content-security-policy']).toContain("default-src 'none'")
        expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
        expect(res.headers['x-content-type-options']).toBe('nosniff')
        expect(res.headers['x-frame-options']).toBe('DENY')
        expect(res.headers['referrer-policy']).toBe('no-referrer')
        expect(res.headers['strict-transport-security']).toBeUndefined() // dev: plain HTTP
      }
    })

    it('adds HSTS when served over HTTPS (Secure cookies)', async () => {
      const app = await buildApp({
        env: {
          NETWORK_MODE: 'testnet',
          APP_ENV: 'production',
          APP_ORIGIN: 'https://da.example',
          SESSION_TTL_HOURS: 12,
          COOKIE_SECURE: 'true',
        },
        logger: createLogger({ name: 'sec-test', level: 'silent' }),
        checkDatabase: async () => 1,
      })
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/)
      await app.close()
    })

    it('never grants cross-origin access (no CORS), and refuses cross-origin writes', async () => {
      await harness()
      const preflight = await h.app.inject({
        method: 'OPTIONS',
        url: '/api/auth/me',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
      })
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined()
      const read = await h.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { origin: 'https://evil.example' },
      })
      expect(read.headers['access-control-allow-origin']).toBeUndefined()
      expect(read.headers['access-control-allow-credentials']).toBeUndefined()
      const write = await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'x@y.z', password: 'whatever-long-enough' }),
      })
      expect(write.statusCode).toBe(403)
    })
  })
})
