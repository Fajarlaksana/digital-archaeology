import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { createLogger } from '@da/shared'
import { buildApp } from '../../../src/app'
import { hashPassword } from '../../../src/auth/password'
import { createSecretBox } from '../../../src/auth/secret-box'
import { newTotpSecret, totpCodeAt } from '../../../src/auth/totp'
import type { Role } from '../../../src/generated/prisma/client'
import type { Database } from '../../../src/lib/prisma'
import { createServices } from '../../../src/services'
import { createFakeChain, type FakeChain } from '../fake-chain'
import { createFakePrices, type FakePrices } from '../fake-prices'
import { createFakeSigner, type FakeSigner } from '../fake-signer'

export const TEST_MFA_KEY = Buffer.alloc(32, 3).toString('base64')
export const PASSWORD = 'correct horse battery staple'
export const APP_ORIGIN = 'http://127.0.0.1:5173'

/** One app per test: own clock, own rate limiters, captured log output. */
export async function createHarness(
  db: Database,
  options: {
    networkMode?: 'testnet' | 'mainnet'
    chain?: FakeChain
    prices?: FakePrices
    signer?: FakeSigner
  } = {},
) {
  let current = new Date('2026-10-02T08:00:00Z')
  const now = () => current
  const logLines: string[] = []
  const logger = createLogger({
    name: 'test',
    level: 'trace',
    destination: new Writable({
      write(chunk: Buffer, _enc, cb) {
        logLines.push(chunk.toString())
        cb()
      },
    }),
  })
  const chain = options.chain ?? createFakeChain()
  const prices = options.prices ?? createFakePrices()
  const signer = options.signer ?? createFakeSigner()
  const enqueued: string[] = []
  const services = createServices(db, {
    mfaEncryptionKey: TEST_MFA_KEY,
    sessionTtlMs: 12 * 3_600_000,
    sessionIdleMs: 30 * 60_000,
    networkMode: options.networkMode ?? 'testnet',
    isEnvSet: (name) => name === 'CONFIGURED_RPC_URL',
    clientsFor: chain.factory,
    enqueueScan: async (scanId) => {
      enqueued.push(scanId)
    },
    defaultThresholdDays: 730,
    logger,
    priceProvider: prices.provider,
    fiatCurrency: 'USD',
    signer: signer.client,
    now,
  })
  const app: FastifyInstance = await buildApp({
    env: {
      NETWORK_MODE: options.networkMode ?? 'testnet',
      APP_ENV: 'test',
      APP_ORIGIN,
      SESSION_TTL_HOURS: 12,
      COOKIE_SECURE: undefined,
    },
    logger,
    checkDatabase: async () => 1,
    services,
  })
  const secretBox = createSecretBox(TEST_MFA_KEY)

  return {
    app,
    services,
    chain,
    prices,
    signer,
    enqueued,
    /** Runs every queued scan to completion (stands in for the BullMQ worker). */
    async runQueuedScans() {
      while (enqueued.length > 0) await services.scans.process(enqueued.shift()!)
    },
    logs: () => logLines.join(''),
    advance(ms: number) {
      current = new Date(current.getTime() + ms)
    },
    now,

    /** Creates a user directly in the DB. With `mfa: true` returns the TOTP secret too. */
    async createUser(roles: Role[], opts: { mfa?: boolean; password?: string } = {}) {
      const email = `${roles.join('-').toLowerCase()}-${randomUUID()}@test.local`
      const secret = opts.mfa ? newTotpSecret() : null
      const user = await db.user.create({
        data: {
          email,
          name: roles.join('/'),
          passwordHash: await hashPassword(opts.password ?? PASSWORD),
          mfaEnabled: Boolean(secret),
          mfaSecretEncrypted: secret ? secretBox.encrypt(secret) : null,
          roles: { create: roles.map((role) => ({ role })) },
        },
      })
      return { id: user.id, email, secret }
    },

    code(secret: string) {
      return totpCodeAt(secret, current)
    },

    async login(email: string, password = PASSWORD, ip = '10.0.0.1') {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password },
        remoteAddress: ip,
      })
      const token = res.cookies.find((c) => c.name === 'da_session')?.value
      return { res, token }
    },

    /** Logs in and completes MFA when needed; returns an ACTIVE session token. */
    async activeSession(user: { email: string; secret: string | null }) {
      const { res, token } = await this.login(user.email)
      if (!token) throw new Error(`login failed: ${res.body}`)
      if (res.json().sessionState === 'MFA_PENDING' && user.secret) {
        const verify = await this.call('POST', '/api/auth/mfa/verify', token, {
          code: this.code(user.secret),
        })
        if (verify.statusCode !== 200) throw new Error(`mfa failed: ${verify.body}`)
      }
      return token
    },

    call(
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      token?: string,
      payload?: unknown,
      headers: Record<string, string> = {},
    ): Promise<LightMyRequestResponse> {
      return app.inject({
        method,
        url,
        cookies: token ? { da_session: token } : {},
        headers,
        ...(payload === undefined ? {} : { payload: payload as object }),
      })
    },
  }
}

export type Harness = Awaited<ReturnType<typeof createHarness>>
