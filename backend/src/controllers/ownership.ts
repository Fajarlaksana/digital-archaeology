import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '@da/shared'
import { AuthorizationStatus, AuthorizationType } from '../generated/prisma/enums'
import { requestMeta, type Guards } from '../auth/plugin'
import type { AddressService } from '../services/address.service'
import type { AuthContext } from '../services/auth.service'
import type { OwnershipService } from '../services/ownership.service'
import { VAULT_REAUTH_WINDOW_MS } from './vault'

const idParams = z.object({ id: z.uuid() })
const createBody = z.object({
  type: z.enum(AuthorizationType),
  reference: z.string().trim().min(1).max(200),
  /** SHA-256 computed in the browser: the document itself is never uploaded (ADR-018). */
  documentSha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 hex digest')
    .nullable()
    .default(null),
  documentName: z.string().trim().max(200).nullable().default(null),
  expiresAt: z.iso.datetime().nullable().default(null),
})
const listQuery = z.object({ status: z.enum(AuthorizationStatus).optional() })
const signatureBody = z.object({
  signature: z.string().trim().max(200),
  method: z.enum(['WALLET', 'MANUAL']),
})

export function registerOwnershipRoutes(
  app: FastifyInstance,
  deps: { ownership: OwnershipService; addresses: AddressService; guards: Guards },
): void {
  const { ownership, guards } = deps
  const read = { preHandler: guards.permission('authorizations:read') }
  const verify = {
    config: { skipGenericAudit: true },
    preHandler: guards.permission('ownership:verify'),
  }
  const ctx = (request: { auth: AuthContext | null }) => request.auth as AuthContext

  app.get('/api/authorizations', read, async (request) => ({
    authorizations: await ownership.listRecent(listQuery.parse(request.query).status),
  }))

  app.get('/api/addresses/:id/authorizations', read, async (request) => ({
    authorizations: await ownership.listForAddress(idParams.parse(request.params).id),
  }))

  app.post('/api/addresses/:id/authorizations', verify, async (request, reply) => {
    const { id } = idParams.parse(request.params)
    const body = createBody.parse(request.body)
    const address = await deps.addresses.get(id) // 404 when missing
    const authorization = await ownership.createAuthorization(
      ctx(request),
      { id: address.id, archivedAt: address.archivedAt ? new Date(address.archivedAt) : null },
      { ...body, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null },
      requestMeta(request),
    )
    return reply.status(201).send({ authorization })
  })

  app.post('/api/authorizations/:id/challenges', verify, async (request, reply) => {
    const challenge = await ownership.createChallenge(
      ctx(request),
      idParams.parse(request.params).id,
      requestMeta(request),
    )
    return reply.status(201).send({ challenge })
  })

  app.post('/api/challenges/:id/signature', verify, async (request) => {
    const body = signatureBody.parse(request.body)
    if (!body.signature) throw new AppError('VALIDATION_ERROR', 'signature is required')
    return ownership.submitSignature(
      ctx(request),
      idParams.parse(request.params).id,
      body,
      requestMeta(request),
    )
  })

  // Vault path: SUPER_ADMIN only, recent re-auth like every other vault action.
  app.post(
    '/api/challenges/:id/vault-signature',
    {
      config: { skipGenericAudit: true },
      preHandler: [guards.permission('vault:manage'), guards.recentAuth(VAULT_REAUTH_WINDOW_MS)],
    },
    async (request) =>
      ownership.signWithVault(
        ctx(request),
        idParams.parse(request.params).id,
        requestMeta(request),
      ),
  )
}
