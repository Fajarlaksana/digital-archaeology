import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requestMeta, type Guards } from '../auth/plugin'
import type { AuthContext } from '../services/auth.service'
import type { EligibilityService } from '../services/eligibility.service'
import type { createEligibilityReport } from '../services/report.service'

const evaluateBody = z.object({ networkId: z.uuid() })
const idParams = z.object({ id: z.uuid() })

/** Recovery eligibility (Phase 8b): evaluate, inspect, export. Read-only towards the chain. */
export function registerEligibilityRoutes(
  app: FastifyInstance,
  deps: {
    eligibility: EligibilityService
    report: ReturnType<typeof createEligibilityReport>
    guards: Guards
  },
): void {
  const { eligibility, guards } = deps

  // Same permission as starting a scan: it reads the chain (fees) and refreshes statuses.
  app.post(
    '/api/eligibility/evaluate',
    { config: { skipGenericAudit: true }, preHandler: guards.permission('scans:run') },
    async (request) =>
      eligibility.evaluateNetwork(evaluateBody.parse(request.body).networkId, {
        actor: request.auth as AuthContext,
        meta: requestMeta(request),
      }),
  )

  app.get(
    '/api/eligibility/config',
    { preHandler: guards.permission('addresses:read') },
    async () => eligibility.config(),
  )

  app.get(
    '/api/addresses/:id/eligibility',
    { preHandler: guards.permission('addresses:read') },
    async (request) => ({
      assets: await eligibility.forAddress(idParams.parse(request.params).id),
    }),
  )

  app.get(
    '/api/reports/eligibility.csv',
    { preHandler: guards.permission('reports:read') },
    async (request, reply) => {
      const csv = await deps.report.csv(request.auth as AuthContext, requestMeta(request))
      const date = new Date().toISOString().slice(0, 10)
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="eligibility-${date}.csv"`)
        .header('cache-control', 'no-store')
        .send(csv)
    },
  )
}
