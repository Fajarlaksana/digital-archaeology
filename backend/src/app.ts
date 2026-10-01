import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, toErrorBody, type Logger } from '@da/shared'
import type { Env } from './config/env'
import { registerHealthRoutes } from './controllers/health'

export interface AppDeps {
  env: Pick<Env, 'NETWORK_MODE'>
  logger: Logger
  checkDatabase: () => Promise<number>
}

export function buildApp(deps: AppDeps): FastifyInstance {
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
      const message = error instanceof Error ? error.message : 'Bad request'
      return reply.status(statusCode).send(toErrorBody('VALIDATION_ERROR', message, request.id))
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

  registerHealthRoutes(app, deps)

  return app
}
