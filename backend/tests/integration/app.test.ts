import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AppError, createLogger } from '@da/shared'
import { buildApp, type AppDeps } from '../../src/app'

let app: FastifyInstance | undefined

async function makeApp(overrides: Partial<AppDeps> = {}): Promise<FastifyInstance> {
  app = await buildApp({
    env: {
      NETWORK_MODE: 'testnet',
      APP_ENV: 'test',
      APP_ORIGIN: 'http://127.0.0.1:5173',
      SESSION_TTL_HOURS: 12,
      COOKIE_SECURE: undefined,
    },
    logger: createLogger({ name: 'test', level: 'silent' }),
    checkDatabase: async () => 3,
    ...overrides,
  })
  return app
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /health', () => {
  it('returns ok with the network mode', async () => {
    const res = await (await makeApp()).inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', service: 'backend', network_mode: 'testnet' })
  })

  it('sets an x-request-id header and ignores a client-supplied one', async () => {
    const res = await (
      await makeApp()
    ).inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'attacker-controlled' },
    })
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('GET /health/database', () => {
  it('returns latency when the database answers', async () => {
    const res = await (await makeApp()).inject({ method: 'GET', url: '/health/database' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', latency_ms: 3 })
  })

  it('returns 503 in the standard error format when the database is down', async () => {
    const res = await (
      await makeApp({
        checkDatabase: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
        },
      })
    ).inject({ method: 'GET', url: '/health/database' })

    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.error).toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      message: 'Database is not reachable',
      resource_id: null,
    })
    expect(body.error.request_id).toBe(res.headers['x-request-id'])
    expect(body.error.timestamp).toEqual(expect.any(String))
  })
})

describe('GET /health/rpc', () => {
  it('is a stub until Phase 5', async () => {
    const res = await (await makeApp()).inject({ method: 'GET', url: '/health/rpc' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('not_implemented')
  })
})

describe('error handling', () => {
  it('returns NOT_FOUND for unknown routes', async () => {
    const res = await (await makeApp()).inject({ method: 'GET', url: '/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
  })

  it('maps AppError to its status, code and resource id', async () => {
    const instance = await makeApp()
    instance.get('/boom-app-error', async () => {
      throw new AppError('INVALID_ADDRESS', 'Address is not valid', { resourceId: 'addr-9' })
    })
    const res = await instance.inject({ method: 'GET', url: '/boom-app-error' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatchObject({ code: 'INVALID_ADDRESS', resource_id: 'addr-9' })
  })

  it('hides internal error details from the client', async () => {
    const instance = await makeApp()
    instance.get('/boom', async () => {
      throw new Error('db password is hunter2')
    })
    const res = await instance.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    })
    expect(res.body).not.toContain('hunter2')
  })
})
