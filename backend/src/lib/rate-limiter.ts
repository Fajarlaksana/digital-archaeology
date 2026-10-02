/**
 * Fixed-window, in-memory attempt counter (single process).
 * Enough for login throttling on one instance; move to Redis when the API scales out.
 */
export function createRateLimiter(options: {
  limit: number
  windowMs: number
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const windows = new Map<string, { count: number; resetAt: number }>()

  function current(key: string) {
    const entry = windows.get(key)
    if (!entry || entry.resetAt <= now()) return undefined
    return entry
  }

  return {
    /** True when the key has used up its attempts in the current window. */
    isLimited(key: string): boolean {
      return (current(key)?.count ?? 0) >= options.limit
    },

    /** Records one attempt (call on failures). */
    hit(key: string): void {
      const entry = current(key)
      if (entry) entry.count += 1
      else windows.set(key, { count: 1, resetAt: now() + options.windowMs })
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (v.resetAt <= now()) windows.delete(k)
      }
    },

    reset(key: string): void {
      windows.delete(key)
    },

    /** Milliseconds until the key's window resets (0 when not limited). */
    retryAfterMs(key: string): number {
      const entry = current(key)
      return entry ? Math.max(0, entry.resetAt - now()) : 0
    },
  }
}

export type RateLimiter = ReturnType<typeof createRateLimiter>
