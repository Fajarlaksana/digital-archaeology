import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { z, ZodError } from 'zod'
import { AppError, toErrorBody, type Logger } from '@da/shared'
import { registerHmacGuard } from './auth/hmac-guard'
import type { VaultService } from './vault/vault.service'

/** Opaque id of the backend user who triggered the action (logged in vault_events). */
const actor = z.uuid()
const passphrase = z.string().min(1).max(1024)

const initBody = z.object({ actor, passphrase, recoveryPassphrase: passphrase })
const unlockBody = z.object({ actor, passphrase })
const lockBody = z.object({ actor })
const changeBody = z.object({ actor, currentPassphrase: passphrase, newPassphrase: passphrase })
const recoverBody = z.object({ actor, recoveryPassphrase: passphrase, newPassphrase: passphrase })

export interface SignerAppDeps {
  logger: Logger
  hmacSecret: string
  vault: VaultService
  now?: () => number
}

/**
 * Internal signer API. Never exposed publicly; only the backend calls it, with HMAC-signed
 * requests. Bodies are never logged (they carry passphrases), and errors never echo input.
 */
export async function buildSignerApp(deps: SignerAppDeps): Promise<FastifyInstance> {
  const loggerInstance: FastifyBaseLogger = deps.logger
  const app = Fastify({
    loggerInstance,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: 16_384,
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn({ code: error.code }, 'SIGNER_REQUEST_FAILED')
      return reply.status(error.statusCode).send(toErrorBody(error.code, error.message, request.id))
    }
    if (error instanceof ZodError) {
      // Field names only: values may be passphrases.
      const fields = [...new Set(error.issues.map((i) => i.path.join('.') || 'body'))].join(', ')
      return reply
        .status(400)
        .send(toErrorBody('VALIDATION_ERROR', `Invalid fields: ${fields}`, request.id))
    }
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500
    if (statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .send(toErrorBody('VALIDATION_ERROR', 'Bad request', request.id))
    }
    request.log.error({ err: error }, 'SIGNER_UNHANDLED_ERROR')
    return reply.status(500).send(toErrorBody('INTERNAL_ERROR', 'Internal error', request.id))
  })
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(toErrorBody('NOT_FOUND', 'Route not found', request.id)),
  )
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
  })

  registerHmacGuard(app, { secret: deps.hmacSecret, logger: deps.logger, now: deps.now })

  app.get('/health', async () => ({ status: 'ok', service: 'signer' }))

  app.get('/vault/status', async () => deps.vault.status())
  app.post('/vault/init', async (request) => deps.vault.init(initBody.parse(request.body)))
  app.post('/vault/unlock', async (request) => deps.vault.unlock(unlockBody.parse(request.body)))
  app.post('/vault/lock', async (request) => deps.vault.lock(lockBody.parse(request.body)))
  app.post('/vault/passphrase', async (request) =>
    deps.vault.changePassphrase(changeBody.parse(request.body)),
  )
  app.post('/vault/recover', async (request) => deps.vault.recover(recoverBody.parse(request.body)))

  return app
}
