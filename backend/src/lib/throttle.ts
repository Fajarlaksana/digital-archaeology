/**
 * Serialises calls so that at most `perSecond` start per second (simple spacing).
 * Used to stay under third-party API rate limits (e.g. Etherscan free tier).
 */
export function createThrottle(
  perSecond: number,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const interval = 1000 / perSecond
  let nextSlot = 0
  let chain: Promise<unknown> = Promise.resolve()

  return function throttle<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = nextSlot - now()
      if (wait > 0) await sleep(wait)
      nextSlot = Math.max(now(), nextSlot) + interval
    })
    chain = run.catch(() => undefined)
    return run.then(task)
  }
}

export type Throttle = ReturnType<typeof createThrottle>
