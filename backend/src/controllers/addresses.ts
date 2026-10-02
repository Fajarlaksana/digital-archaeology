import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { MAX_LABEL_LENGTH, MAX_OWNER_REFERENCE_LENGTH } from '../domain/address-import'
import { ActivityStatus } from '../generated/prisma/enums'
import { requestMeta, type Guards } from '../auth/plugin'
import { MAX_CSV_CHARS, type AddressService } from '../services/address.service'
import type { AuthContext } from '../services/auth.service'

const ownerReference = z
  .string()
  .trim()
  .min(1, 'owner_reference is required')
  .max(MAX_OWNER_REFERENCE_LENGTH)
const label = z.string().trim().max(MAX_LABEL_LENGTH)

const listQuery = z.object({
  networkId: z.uuid().optional(),
  activityStatus: z.enum(ActivityStatus).optional(),
  search: z.string().trim().max(100).optional(),
  archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

const createBody = z.object({
  networkId: z.uuid(),
  address: z.string().trim().max(100),
  label: label.nullable().default(null),
  ownerReference,
})

const updateBody = z
  .object({ label: label.nullable().optional(), ownerReference: ownerReference.optional() })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update')

const archiveBody = z.object({ reason: z.string().trim().max(200).nullable().default(null) })
const importBody = z.object({ csv: z.string().min(1).max(MAX_CSV_CHARS) })
const idParams = z.object({ id: z.uuid() })

/** JSON-wrapped CSV can be larger than Fastify's 1 MB default. */
const IMPORT_BODY_LIMIT = 3 * 1024 * 1024

export function registerAddressRoutes(
  app: FastifyInstance,
  deps: { addresses: AddressService; guards: Guards },
): void {
  const { addresses, guards } = deps
  const read = { preHandler: guards.permission('addresses:read') }
  const manage = { preHandler: guards.permission('addresses:manage') }

  app.get('/api/addresses', read, async (request) => addresses.list(listQuery.parse(request.query)))

  app.get('/api/addresses/:id', read, async (request) => ({
    address: await addresses.get(idParams.parse(request.params).id),
  }))

  app.post('/api/addresses', manage, async (request, reply) => {
    const body = createBody.parse(request.body)
    const address = await addresses.create(request.auth as AuthContext, body, requestMeta(request))
    return reply.status(201).send({ address })
  })

  app.patch('/api/addresses/:id', manage, async (request) => {
    const { id } = idParams.parse(request.params)
    const body = updateBody.parse(request.body)
    return {
      address: await addresses.update(request.auth as AuthContext, id, body, requestMeta(request)),
    }
  })

  app.post('/api/addresses/:id/archive', manage, async (request) => {
    const { id } = idParams.parse(request.params)
    const { reason } = archiveBody.parse(request.body ?? {})
    return {
      address: await addresses.archive(
        request.auth as AuthContext,
        id,
        reason,
        requestMeta(request),
      ),
    }
  })

  app.post('/api/addresses/:id/restore', manage, async (request) => {
    const { id } = idParams.parse(request.params)
    return {
      address: await addresses.restore(request.auth as AuthContext, id, requestMeta(request)),
    }
  })

  app.post(
    '/api/addresses/import/preview',
    { ...manage, bodyLimit: IMPORT_BODY_LIMIT },
    async (request) => addresses.previewImport(importBody.parse(request.body).csv),
  )

  app.post(
    '/api/addresses/import',
    { ...manage, bodyLimit: IMPORT_BODY_LIMIT },
    async (request) => {
      const { csv } = importBody.parse(request.body)
      return addresses.commitImport(request.auth as AuthContext, csv, requestMeta(request))
    },
  )
}
