import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { Logger } from '@da/shared'

/**
 * Fixed-window attempt counter (login / MFA throttling).
 * In memory for a single process; in Redis when the API runs as several instances (ADR-027).
 */
export interface RateLimiter {
  /** True when the key has used up its attempts in the current window. */
  isLimited(key: string): Promise<boolean>
  /** Records one attempt (call on failures). */
  hit(key: string): Promise<void>
  reset(key: string): Promise<void>
}

export interface LimitOptions {
  limit: number
  windowMs: number
}

/** Builds one named limiter (e.g. "login-account"); injected so tests can keep memory ones. */
export type RateLimiterFactory = (name: string, options: LimitOptions) => RateLimiter

export function createRateLimiter(options: LimitOptions & { now?: () => number }): RateLimiter {
  const now = options.now ?? Date.now
  const windows = new Map<string, { count: number; resetAt: number }>()

  function current(key: string) {
    const entry = windows.get(key)
    if (!entry || entry.resetAt <= now()) return undefined
    return entry
  }

  return {
    async isLimited(key) {
      return (current(key)?.count ?? 0) >= options.limit
    },
    async hit(key) {
      const entry = current(key)
      if (entry) entry.count += 1
      else windows.set(key, { count: 1, resetAt: now() + options.windowMs })
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (v.resetAt <= now()) windows.delete(k)
      }
    },
    async reset(key) {
      windows.delete(key)
    },
  }
}

/** Memory limiters with a shared clock (the default, and what tests use). */
export function memoryRateLimiterFactory(now?: () => number): RateLimiterFactory {
  return (_name, options) => createRateLimiter({ ...options, now })
}

/**
 * Redis limiters shared by every backend instance. Keys are hashed (no e-mail addresses or IPs
 * are stored in Redis). If Redis is unreachable the limiter keeps working in memory for this
 * process — throttling degrades to per-instance rather than disappearing.
 */
export function redisRateLimiterFactory(redis: Redis, logger: Logger): RateLimiterFactory {
  let lastWarning = 0
  const warn = (err: unknown) => {
    if (Date.now() - lastWarning < 60_000) return
    lastWarning = Date.now()
    logger.warn(
      { code: (err as { code?: string })?.code ?? 'UNKNOWN' },
      'RATE_LIMITER_REDIS_UNAVAILABLE',
    )
  }

  return (name, options) => {
    const fallback = createRateLimiter(options)
    const redisKey = (key: string) =>
      `da:rl:${name}:${createHash('sha256').update(key).digest('hex')}`
    const guarded = async <T>(viaRedis: () => Promise<T>, viaMemory: () => Promise<T>) => {
      try {
        return await viaRedis()
      } catch (err) {
        warn(err)
        return viaMemory()
      }
    }

    return {
      isLimited: (key) =>
        guarded(
          async () => Number((await redis.get(redisKey(key))) ?? 0) >= options.limit,
          () => fallback.isLimited(key),
        ),
      hit: (key) =>
        guarded(
          async () => {
            const k = redisKey(key)
            // INCR then start the window only once (NX): a fixed window from the first failure.
            const result = await redis.multi().incr(k).pexpire(k, options.windowMs, 'NX').exec()
            const failed = result?.find(([err]) => err)
            if (!result || failed) throw failed?.[0] ?? new Error('Redis transaction aborted')
          },
          () => fallback.hit(key),
        ),
      reset: (key) =>
        guarded(
          async () => {
            await redis.del(redisKey(key))
          },
          () => fallback.reset(key),
        ),
    }
  }
}
