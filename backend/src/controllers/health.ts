import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AppError } from '@da/shared'
import type { Env } from '../config/env'
import type { RpcHealth } from '../services/chain-health'

export interface HealthDeps {
  env: Pick<Env, 'NETWORK_MODE'>
  checkDatabase: () => Promise<number>
  /** Absent in infrastructure-only tests. */
  checkRpc?: () => Promise<RpcHealth>
  /** Redis ping (rate limiters, queues). */
  checkRedis?: () => Promise<unknown>
  /** Signer reachability; resolves to whether the vault is initialised. Never the lock state. */
  checkSigner?: () => Promise<{ initialized: boolean }>
  /** Prometheus exposition; /metrics answers 404 unless both this and the token are set. */
  metrics?: { render: () => Promise<string>; token: string | undefined }
}

async function probe(fn: (() => Promise<unknown>) | undefined) {
  if (!fn) return 'not_configured' as const
  try {
    await fn()
    return 'ok' as const
  } catch {
    return 'unavailable' as const
  }
}

const sameToken = (given: string, expected: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
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

  // The signer is reachable (HMAC works) and the vault exists. Lock state is NOT exposed here.
  app.get('/health/vault', open, async (_request, reply) => {
    if (!deps.checkSigner) return { status: 'not_configured' }
    try {
      const { initialized } = await deps.checkSigner()
      return { status: 'ok', initialized }
    } catch {
      return reply.status(503).send({ status: 'unavailable' })
    }
  })

  // Readiness for a load balancer / orchestrator: every dependency the API needs to serve.
  app.get('/health/ready', open, async (_request, reply) => {
    const checks = {
      database: await probe(deps.checkDatabase),
      redis: await probe(deps.checkRedis),
      signer: await probe(deps.checkSigner),
    }
    const ready = Object.values(checks).every((c) => c !== 'unavailable')
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks })
  })

  // Prometheus scrape endpoint (SA 10). Bearer token, constant-time comparison; 404 when disabled.
  app.get('/metrics', open, async (request, reply) => {
    const token = deps.metrics?.token
    if (!deps.metrics || !token) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
    }
    const header = request.headers.authorization ?? ''
    const given = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!sameToken(given, token)) {
      return reply
        .status(401)
        .send({ error: { code: 'UNAUTHORIZED', message: 'Metrics token required' } })
    }
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(await deps.metrics.render())
  })

  // Per-network: RPC reachable, chain id matches, latest block readable. Never exposes URLs.
  app.get('/health/rpc', open, async (_request, reply) => {
    if (!deps.checkRpc) return { status: 'not_configured', networks: [] }
    const health = await deps.checkRpc()
    return reply.status(health.status === 'degraded' ? 503 : 200).send(health)
  })
}
