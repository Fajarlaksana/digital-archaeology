import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requestMeta, type Guards } from '../auth/plugin'
import type { AuthContext } from '../services/auth.service'
import type { ScanService } from '../services/scan.service'

const amount = z
  .string()
  .trim()
  .max(80)
  .regex(/^\d*(\.\d+)?$/, 'must be a plain decimal amount')
  .nullable()
  .optional()

const createBody = z.object({
  networkId: z.uuid(),
  thresholdDays: z.number().int().min(1).max(36_500).optional(),
  minimumBalance: amount,
  maximumBalance: amount,
})

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
const resultsQuery = pageQuery.extend({
  filter: z.enum(['all', 'inactive', 'review', 'failed', 'criteria']).default('all'),
})
const idParams = z.object({ id: z.uuid() })

export function registerScanRoutes(
  app: FastifyInstance,
  deps: { scans: ScanService; guards: Guards },
): void {
  const { scans, guards } = deps
  const read = { preHandler: guards.permission('scans:read') }

  app.get('/api/scans', read, async (request) => {
    const { page, pageSize } = pageQuery.parse(request.query)
    return scans.list(page, pageSize)
  })

  app.post('/api/scans', { preHandler: guards.permission('scans:run') }, async (request, reply) => {
    const body = createBody.parse(request.body)
    const scan = await scans.create(request.auth as AuthContext, body, requestMeta(request))
    return reply.status(202).send({ scan })
  })

  app.get('/api/scans/:id', read, async (request) => ({
    scan: await scans.get(idParams.parse(request.params).id),
  }))

  app.get('/api/scans/:id/results', read, async (request) => {
    const { id } = idParams.parse(request.params)
    const { filter, page, pageSize } = resultsQuery.parse(request.query)
    return scans.results(id, filter, page, pageSize)
  })

  // Per-address views live under /api/addresses but come from scan data.
  const readAddresses = { preHandler: guards.permission('addresses:read') }

  app.get('/api/addresses/:id/activity', readAddresses, async (request) => ({
    history: await scans.addressHistory(idParams.parse(request.params).id),
  }))

  app.get('/api/addresses/:id/balances', readAddresses, async (request) => ({
    balances: await scans.addressBalances(idParams.parse(request.params).id),
  }))
}
