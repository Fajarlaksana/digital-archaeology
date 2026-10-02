import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  AppError,
  HMAC_MAX_SKEW_MS,
  HMAC_SIGNATURE_HEADER,
  HMAC_TIMESTAMP_HEADER,
  verifyRequest,
  type Logger,
} from '@da/shared'

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string
  }
}

/** Routes reachable without a signature: liveness only, no data. */
const PUBLIC_ROUTES = new Set(['GET /health'])

/**
 * Every request (except liveness) must be signed by the backend with SIGNER_HMAC_SECRET.
 * Signatures are single-use: a replayed request inside the time window is rejected too.
 */
export function registerHmacGuard(
  app: FastifyInstance,
  options: { secret: string; logger: Logger; now?: () => number },
): void {
  const now = options.now ?? Date.now
  const seen = new Map<string, number>()

  // Keep the exact body text: the signature covers its bytes, not a re-serialisation.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 16_384 },
    (request, body, done) => {
      const text = body as string
      ;(request as FastifyRequest).rawBody = text
      try {
        done(null, text.length ? JSON.parse(text) : {})
      } catch {
        done(new AppError('VALIDATION_ERROR', 'Body is not valid JSON'), undefined)
      }
    },
  )

  app.addHook('preHandler', async (request) => {
    if (PUBLIC_ROUTES.has(`${request.method} ${request.routeOptions.url}`)) return

    const header = (name: string) => {
      const value = request.headers[name]
      return Array.isArray(value) ? value[0] : value
    }
    const check = verifyRequest(options.secret, {
      method: request.method,
      path: request.url,
      body: request.rawBody ?? '',
      timestamp: header(HMAC_TIMESTAMP_HEADER),
      signature: header(HMAC_SIGNATURE_HEADER),
      now: now(),
    })

    for (const [signature, expiry] of seen) if (expiry <= now()) seen.delete(signature)
    if (check.ok && seen.has(check.signature)) {
      options.logger.warn({ url: request.url }, 'SIGNER_REPLAY_REJECTED')
      throw new AppError('UNAUTHORIZED', 'Request rejected')
    }
    if (!check.ok) {
      options.logger.warn({ url: request.url, reason: check.reason }, 'SIGNER_AUTH_REJECTED')
      throw new AppError('UNAUTHORIZED', 'Request rejected')
    }
    seen.set(check.signature, now() + 2 * HMAC_MAX_SKEW_MS)
  })
}
