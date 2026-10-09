import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { AuditResult } from '../generated/prisma/enums'
import { requestMeta, type Guards } from '../auth/plugin'
import type { AuditService } from '../services/audit.service'
import type { AuthContext } from '../services/auth.service'
import type { OperationalReports } from '../services/operational-reports'

const auditFilter = z.object({
  category: z.enum(['sensitive']).optional(),
  action: z.string().trim().max(100).optional(),
  userId: z.uuid().optional(),
  result: z.enum(AuditResult).optional(),
  resourceType: z.string().trim().max(50).optional(),
  resourceId: z.string().trim().max(200).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})
const auditList = auditFilter.extend({
  before: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
const reviewBody = z.object({
  upToSequence: z.string().regex(/^\d{1,19}$/),
  note: z.string().trim().min(10).max(1000),
})
const networkFilter = z.object({ networkId: z.uuid().optional() })
const transactionFilter = networkFilter.extend({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})

const dates = <T extends { from?: string; to?: string }>(q: T) => ({
  ...q,
  from: q.from ? new Date(q.from) : undefined,
  to: q.to ? new Date(q.to) : undefined,
})

function sendCsv(reply: FastifyReply, name: string, csv: string) {
  const date = new Date().toISOString().slice(0, 10)
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}-${date}.csv"`)
    .header('cache-control', 'no-store')
    .send(csv)
}

/** Audit Logs (AUDITOR, read-only) and the remaining SA 21 reports (Phase 12, ADR-025). */
export function registerAuditAndReportRoutes(
  app: FastifyInstance,
  deps: { audit: AuditService; reports: OperationalReports; guards: Guards },
): void {
  const { guards } = deps
  const auditRead = { preHandler: guards.permission('audit:read') }
  const reportRead = { preHandler: guards.permission('reports:read') }
  const ctx = (request: { auth: AuthContext | null }) => request.auth as AuthContext

  app.get('/api/audit-logs', auditRead, async (request) =>
    deps.audit.list(dates(auditList.parse(request.query))),
  )
  app.get('/api/audit-logs/reviews/status', auditRead, async () => deps.audit.reviewStatus())
  // Periodic AUDITOR review (Phase 13b): "everything up to #N was looked at", with a note.
  app.post(
    '/api/audit-logs/reviews',
    { ...auditRead, config: { skipGenericAudit: true } },
    async (request) =>
      deps.audit.markReviewed(ctx(request), reviewBody.parse(request.body), requestMeta(request)),
  )
  app.get('/api/audit-logs/actions', auditRead, async () => ({
    actions: await deps.audit.actions(),
  }))
  // Recomputes the hash chain; read-only apart from recording that a check happened.
  app.post(
    '/api/audit-logs/verify',
    { ...auditRead, config: { skipGenericAudit: true } },
    async (request) => deps.audit.verify(ctx(request), requestMeta(request)),
  )
  app.get('/api/reports/audit.csv', auditRead, async (request, reply) =>
    sendCsv(
      reply,
      'audit',
      await deps.audit.csv(
        ctx(request),
        dates(auditFilter.parse(request.query)),
        requestMeta(request),
      ),
    ),
  )

  app.get('/api/reports/balances.csv', reportRead, async (request, reply) =>
    sendCsv(
      reply,
      'balances',
      await deps.reports.balancesCsv(
        ctx(request),
        networkFilter.parse(request.query),
        requestMeta(request),
      ),
    ),
  )
  app.get('/api/reports/authorizations.csv', reportRead, async (request, reply) =>
    sendCsv(
      reply,
      'authorizations',
      await deps.reports.authorizationsCsv(
        ctx(request),
        networkFilter.parse(request.query),
        requestMeta(request),
      ),
    ),
  )
  app.get('/api/reports/transactions.csv', reportRead, async (request, reply) =>
    sendCsv(
      reply,
      'transactions',
      await deps.reports.transactionsCsv(
        ctx(request),
        dates(transactionFilter.parse(request.query)),
        requestMeta(request),
      ),
    ),
  )
}
