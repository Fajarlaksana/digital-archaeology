import pg from 'pg'
import type { Logger } from '@da/shared'

/**
 * Minimal Postgres access for health checks.
 * Replaced by the Prisma client in Phase 2.
 */
export function createDatabase(connectionString: string, logger: Logger) {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 3000 })

  // An idle client error must not crash the process.
  pool.on('error', (err) => logger.error({ err }, 'DATABASE_POOL_ERROR'))

  return {
    /** Runs `SELECT 1` and returns the round-trip latency in milliseconds. */
    async check(): Promise<number> {
      const start = performance.now()
      await pool.query('SELECT 1')
      return Math.round(performance.now() - start)
    },
    close: () => pool.end(),
  }
}
