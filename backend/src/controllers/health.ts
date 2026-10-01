import type { FastifyInstance } from 'fastify'
import { AppError } from '@da/shared'
import type { Env } from '../config/env'

export interface HealthDeps {
  env: Pick<Env, 'NETWORK_MODE'>
  checkDatabase: () => Promise<number>
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'backend',
    network_mode: deps.env.NETWORK_MODE,
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }))

  app.get('/health/database', async () => {
    try {
      const latencyMs = await deps.checkDatabase()
      return { status: 'ok', latency_ms: latencyMs }
    } catch (cause) {
      throw new AppError('DATABASE_UNAVAILABLE', 'Database is not reachable', { cause })
    }
  })

  // Real RPC connectivity check arrives with the chain adapter in Phase 5.
  app.get('/health/rpc', async () => ({
    status: 'not_implemented',
    message: 'RPC health check is implemented in Phase 5',
  }))
}
