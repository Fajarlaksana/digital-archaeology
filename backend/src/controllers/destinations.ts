import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { DestinationStatus } from '../generated/prisma/enums'
import { requestMeta, type Guards } from '../auth/plugin'
import type { AuthContext } from '../services/auth.service'
import type { DestinationService } from '../services/destination.service'

/** Approving a destination decides where assets may go: re-confirm identity first. */
export const DESTINATION_REAUTH_WINDOW_MS = 5 * 60_000

const idParams = z.object({ id: z.uuid() })
const listQuery = z.object({
  networkId: z.uuid().optional(),
  status: z.enum(DestinationStatus).optional(),
})
const createBody = z.object({
  networkId: z.uuid(),
  address: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(100),
})
const signatureBody = z.object({
  signature: z.string().trim().min(1).max(200),
  method: z.enum(['WALLET', 'MANUAL']),
})
const approveBody = z.object({ note: z.string().trim().max(500).nullable().default(null) })
const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) })

export function registerDestinationRoutes(
  app: FastifyInstance,
  deps: { destinations: DestinationService; guards: Guards },
): void {
  const { destinations, guards } = deps
  const read = { preHandler: guards.permission('destinations:read') }
  const create = {
    config: { skipGenericAudit: true },
    preHandler: guards.permission('destinations:create'),
  }
  const decide = {
    config: { skipGenericAudit: true },
    preHandler: [
      guards.permission('destinations:approve'),
      guards.recentAuth(DESTINATION_REAUTH_WINDOW_MS),
    ],
  }
  const ctx = (request: { auth: AuthContext | null }) => request.auth as AuthContext
  const id = (request: { params: unknown }) => idParams.parse(request.params).id

  app.get('/api/destinations', read, async (request) => ({
    destinations: await destinations.list(listQuery.parse(request.query)),
  }))
  app.get('/api/destinations/:id', read, async (request) => ({
    destination: await destinations.get(id(request)),
  }))

  app.post('/api/destinations', create, async (request, reply) => {
    const destination = await destinations.create(
      ctx(request),
      createBody.parse(request.body),
      requestMeta(request),
    )
    return reply.status(201).send({ destination })
  })
  app.post('/api/destinations/:id/challenges', create, async (request, reply) => {
    const challenge = await destinations.createChallenge(
      ctx(request),
      id(request),
      requestMeta(request),
    )
    return reply.status(201).send({ challenge })
  })
  app.post('/api/destination-challenges/:id/signature', create, async (request) =>
    destinations.submitSignature(
      ctx(request),
      id(request),
      signatureBody.parse(request.body),
      requestMeta(request),
    ),
  )
  app.post('/api/destinations/:id/resubmit', create, async (request) => ({
    destination: await destinations.resubmit(ctx(request), id(request), requestMeta(request)),
  }))

  app.post('/api/destinations/:id/approve', decide, async (request) => ({
    destination: await destinations.approve(
      ctx(request),
      id(request),
      approveBody.parse(request.body ?? {}),
      requestMeta(request),
    ),
  }))
  app.post('/api/destinations/:id/reject', decide, async (request) => ({
    destination: await destinations.reject(
      ctx(request),
      id(request),
      reasonBody.parse(request.body),
      requestMeta(request),
    ),
  }))
  app.post('/api/destinations/:id/disable', decide, async (request) => ({
    destination: await destinations.disable(
      ctx(request),
      id(request),
      reasonBody.parse(request.body),
      requestMeta(request),
    ),
  }))
}
