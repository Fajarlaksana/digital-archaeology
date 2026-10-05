import type { FastifyInstance } from 'fastify'
import { AppError } from '@da/shared'
import type { Env } from '../config/env'
import type { RpcHealth } from '../services/chain-health'

export interface HealthDeps {
  env: Pick<Env, 'NETWORK_MODE'>
  checkDatabase: () => Promise<number>
  /** Absent in infrastructure-only tests. */
  checkRpc?: () => Promise<RpcHealth>
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  const open = { config: { public: true } }

  app.get('/health', open, async () => ({
    status: 'ok',
    service: 'backend',
    network_mode: deps.env.NETWORK_MODE,
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }))

  app.get('/health/database', open, async () => {
    try {
      const latencyMs = await deps.checkDatabase()
      return { status: 'ok', latency_ms: latencyMs }
    } catch (cause) {
      throw new AppError('DATABASE_UNAVAILABLE', 'Database is not reachable', { cause })
    }
  })

  // Per-network: RPC reachable, chain id matches, latest block readable. Never exposes URLs.
  app.get('/health/rpc', open, async (_request, reply) => {
    if (!deps.checkRpc) return { status: 'not_configured', networks: [] }
    const health = await deps.checkRpc()
    return reply.status(health.status === 'degraded' ? 503 : 200).send(health)
  })
}
