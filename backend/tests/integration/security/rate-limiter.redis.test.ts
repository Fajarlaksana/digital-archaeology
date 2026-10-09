import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLogger } from '@da/shared'
import { loadEnvFile } from '../../../src/config/env'
import { redisRateLimiterFactory } from '../../../src/lib/rate-limiter'

loadEnvFile()
const redisUrl = process.env.REDIS_URL
const logger = createLogger({ name: 'limiter-test', level: 'silent' })

async function reachable(url: string | undefined): Promise<boolean> {
  if (!url) return false
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1000 })
  probe.on('error', () => undefined)
  try {
    await probe.connect()
    await probe.ping()
    return true
  } catch {
    return false
  } finally {
    probe.disconnect()
  }
}
const available = await reachable(redisUrl)

describe.skipIf(!available)('Redis rate limiter (shared by API instances)', () => {
  let a: Redis
  let b: Redis
  beforeAll(() => {
    a = new Redis(redisUrl!, { maxRetriesPerRequest: 1 })
    b = new Redis(redisUrl!, { maxRetriesPerRequest: 1 })
  })
  afterAll(() => {
    a?.disconnect()
    b?.disconnect()
  })

  it('two instances share one counter; reset clears it; keys never contain the raw key', async () => {
    const name = `test-${randomUUID().slice(0, 8)}`
    const one = redisRateLimiterFactory(a, logger)(name, { limit: 3, windowMs: 60_000 })
    const two = redisRateLimiterFactory(b, logger)(name, { limit: 3, windowMs: 60_000 })
    const key = '10.0.0.1|someone@example.com'
    await one.hit(key)
    await two.hit(key)
    expect(await one.isLimited(key)).toBe(false)
    await one.hit(key)
    expect(await two.isLimited(key)).toBe(true) // the other instance sees it too
    const keys = await a.keys(`da:rl:${name}:*`)
    expect(keys).toHaveLength(1)
    expect(keys[0]).not.toContain('someone@example.com')
    expect(await a.pttl(keys[0]!)).toBeGreaterThan(50_000) // fixed window started once
    await two.reset(key)
    expect(await one.isLimited(key)).toBe(false)
  })

  it('the window expires', async () => {
    const limiter = redisRateLimiterFactory(a, logger)(`test-${randomUUID().slice(0, 8)}`, {
      limit: 1,
      windowMs: 200,
    })
    await limiter.hit('k')
    expect(await limiter.isLimited('k')).toBe(true)
    await new Promise((r) => setTimeout(r, 350))
    expect(await limiter.isLimited('k')).toBe(false)
  })
})

describe('Redis rate limiter without Redis', () => {
  it('keeps throttling in memory when Redis is down', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    })
    dead.on('error', () => undefined)
    const limiter = redisRateLimiterFactory(dead, logger)('down', { limit: 2, windowMs: 60_000 })
    await limiter.hit('k')
    await limiter.hit('k')
    expect(await limiter.isLimited('k')).toBe(true)
    await limiter.reset('k')
    expect(await limiter.isLimited('k')).toBe(false)
    dead.disconnect()
  })
})
