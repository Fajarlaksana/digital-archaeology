import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, toErrorBody, type Logger } from '@da/shared'
import { createGuards, registerAuth, type AuthPluginOptions } from './auth/plugin'
import type { Env } from './config/env'
import { registerAddressRoutes } from './controllers/addresses'
import { registerAuthRoutes } from './controllers/auth'
import { registerHealthRoutes } from './controllers/health'
import { registerNetworkRoutes } from './controllers/networks'
import { registerOverviewRoutes } from './controllers/overview'
import { registerDestinationRoutes } from './controllers/destinations'
import { registerEligibilityRoutes } from './controllers/eligibility'
import { registerOwnershipRoutes } from './controllers/ownership'
import { registerScanRoutes } from './controllers/scans'
import { registerUserRoutes } from './controllers/users'
import { registerVaultRoutes } from './controllers/vault'
import type { AppServices } from './services'

const CLIENT_ERROR_MESSAGES: Record<string, string> = {
  FST_ERR_CTP_INVALID_JSON_BODY: 'Body is not valid JSON',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'Body must not be empty',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'Unsupported content type (use application/json)',
  FST_ERR_CTP_BODY_TOO_LARGE: 'Request body is too large',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'Invalid content length',
}

export type AppEnv = Pick<
  Env,
  'NETWORK_MODE' | 'APP_ENV' | 'APP_ORIGIN' | 'SESSION_TTL_HOURS' | 'COOKIE_SECURE'
>

export interface AppDeps {
  env: AppEnv
  logger: Logger
  checkDatabase: () => Promise<number>
  /** Omitted only in tests that exercise infrastructure routes (health, error handling). */
  services?: AppServices
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Typed as Fastify's base logger so the instance keeps the default FastifyInstance type.
  const loggerInstance: FastifyBaseLogger = deps.logger
  const app = Fastify({
    loggerInstance,
    // Always generate our own id; never trust a client-supplied one.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  })

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      const level = error.statusCode >= 500 ? 'error' : 'warn'
      request.log[level]({ err: error, code: error.code }, 'REQUEST_FAILED')
      return reply
        .status(error.statusCode)
        .send(toErrorBody(error.code, error.message, request.id, error.resourceId))
    }

    if (error instanceof ZodError) {
      const message = error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ')
      return reply.status(400).send(toErrorBody('VALIDATION_ERROR', message, request.id))
    }

    // Fastify's own client errors (schema validation, bad JSON, payload too large, ...).
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500
    if (statusCode >= 400 && statusCode < 500) {
      // Fixed messages only: a library message could one day quote the request body,
      // and bodies here can carry passphrases or keys.
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      return reply
        .status(statusCode)
        .send(
          toErrorBody('VALIDATION_ERROR', CLIENT_ERROR_MESSAGES[code] ?? 'Bad request', request.id),
        )
    }

    // Unknown failure: log the details, but never leak them to the client.
    request.log.error({ err: error }, 'UNHANDLED_ERROR')
    return reply
      .status(500)
      .send(toErrorBody('INTERNAL_ERROR', 'Internal server error', request.id))
  })

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(toErrorBody('NOT_FOUND', 'Route not found', request.id)),
  )

  registerHealthRoutes(app, {
    env: deps.env,
    checkDatabase: deps.checkDatabase,
    checkRpc: deps.services?.checkRpc,
  })

  if (deps.services) {
    const { services, env } = deps
    const authOptions: AuthPluginOptions = {
      auth: services.auth,
      audit: services.audit,
      logger: deps.logger,
      appOrigin: env.APP_ORIGIN,
      cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.APP_ENV === 'production',
      sessionTtlMs: env.SESSION_TTL_HOURS * 3_600_000,
      now: services.now,
    }
    await registerAuth(app, authOptions)
    const guards = createGuards(authOptions)
    registerAuthRoutes(app, {
      auth: services.auth,
      guards,
      cookie: authOptions,
      // Logging out a SUPER_ADMIN locks the vault (ADR-008).
      onLogout: (ctx, meta) => services.vault.lockOnLogout(ctx, meta),
    })
    registerUserRoutes(app, { users: services.users, guards })
    registerNetworkRoutes(app, { networks: services.networks, guards })
    registerAddressRoutes(app, { addresses: services.addresses, guards })
    registerScanRoutes(app, { scans: services.scans, guards })
    registerVaultRoutes(app, { vault: services.vault, auth: services.auth, guards })
    registerOwnershipRoutes(app, {
      ownership: services.ownership,
      addresses: services.addresses,
      guards,
    })
    registerDestinationRoutes(app, { destinations: services.destinations, guards })
    registerEligibilityRoutes(app, {
      eligibility: services.eligibility,
      report: services.eligibilityReport,
      guards,
    })
    registerOverviewRoutes(app, {
      dashboard: services.dashboard,
      reports: services.reports,
      valuation: services.valuation,
      guards,
    })
  }

  return app
}
