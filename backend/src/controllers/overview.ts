import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requestMeta, type Guards } from '../auth/plugin'
import type { AuthContext } from '../services/auth.service'
import type { DashboardService } from '../services/dashboard.service'
import type { ReportService } from '../services/report.service'
import type { ValuationService } from '../services/valuation.service'

const dashboardQuery = z.object({ networkId: z.uuid().optional() })
const reportQuery = z.object({ type: z.enum(['inventory', 'inactivity']).default('inventory') })
const assetParams = z.object({ id: z.uuid(), assetId: z.uuid() })
const priceIdBody = z.object({
  /** CoinGecko coin id, e.g. "ethereum", "usd-coin". */
  priceId: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,99}$/, 'lowercase CoinGecko id, e.g. "ethereum"')
    .nullable(),
})

/** Dashboard, CSV reports and price management (Phase 6). */
export function registerOverviewRoutes(
  app: FastifyInstance,
  deps: {
    dashboard: DashboardService
    reports: ReportService
    valuation: ValuationService
    guards: Guards
  },
): void {
  const { guards } = deps

  app.get('/api/dashboard', { preHandler: guards.permission('addresses:read') }, async (request) =>
    deps.dashboard.summary(dashboardQuery.parse(request.query).networkId),
  )

  app.get(
    '/api/reports/addresses.csv',
    { preHandler: guards.permission('reports:read') },
    async (request, reply) => {
      const { type } = reportQuery.parse(request.query)
      const { csv } = await deps.reports.addressesCsv(
        request.auth as AuthContext,
        type,
        requestMeta(request),
      )
      const date = new Date().toISOString().slice(0, 10)
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="addresses-${type}-${date}.csv"`)
        .header('cache-control', 'no-store')
        .send(csv)
    },
  )

  app.post('/api/prices/refresh', { preHandler: guards.permission('networks:manage') }, async () =>
    deps.valuation.updatePrices(),
  )

  app.patch(
    '/api/networks/:id/assets/:assetId',
    { preHandler: guards.permission('networks:manage') },
    async (request) => {
      const { id, assetId } = assetParams.parse(request.params)
      const { priceId } = priceIdBody.parse(request.body)
      const asset = await deps.valuation.setPriceId(
        request.auth as AuthContext,
        id,
        assetId,
        priceId,
        requestMeta(request),
      )
      return { asset: { id: asset.id, symbol: asset.symbol, priceId: asset.priceId } }
    },
  )
}
