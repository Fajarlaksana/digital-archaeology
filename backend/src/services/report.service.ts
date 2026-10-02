import { fromBaseUnit } from '../domain/money'
import { toCsv } from '../lib/csv'
import type { Database } from '../lib/prisma'
import { fromDbAmount } from '../repositories/amount'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import { recordAction } from './audit-trail'
import type { AuthContext, RequestMeta } from './auth.service'

export type AddressReport = 'inventory' | 'inactivity'

/** Upper bound for one export; larger inventories should be filtered first. */
export const MAX_REPORT_ADDRESSES = 50_000

/**
 * SA 13: reports must keep public chain data, estimates, authorization data and statuses
 * clearly apart — hence explicit column names (estimated_value, value_simulated, price_*).
 */
export const REPORT_HEADERS = [
  'address',
  'network',
  'label',
  'owner_reference',
  'activity_status',
  'inactive_days',
  'last_outgoing_at',
  'last_activity_at',
  'last_scanned_at',
  'asset',
  'balance',
  'balance_base_units',
  'fiat_currency',
  'estimated_value',
  'value_simulated',
  'price_source',
  'priced_at',
  'authorization_status',
  'recovery_status',
  'review_note',
  'archived_at',
] as const

export function createReportService(deps: {
  db: Database
  audit: AuditLogRepository
  fiatCurrency: string
}) {
  const { db, fiatCurrency } = deps

  return {
    async addressesCsv(actor: AuthContext, type: AddressReport, meta: RequestMeta) {
      const addresses = await db.address.findMany({
        where: {
          archivedAt: null,
          ...(type === 'inactivity' ? { activityStatus: 'INACTIVE' } : {}),
        },
        include: {
          network: true,
          balances: {
            include: { asset: true, priceSnapshot: true },
            orderBy: [{ asset: { isNative: 'desc' } }, { asset: { symbol: 'asc' } }],
          },
        },
        orderBy: [{ network: { name: 'asc' } }, { address: 'asc' }],
        take: MAX_REPORT_ADDRESSES,
      })

      const iso = (d: Date | null) => d?.toISOString() ?? ''
      const rows: unknown[][] = []
      for (const a of addresses) {
        const common = [
          a.address,
          a.network.name,
          a.label ?? '',
          a.ownerReference,
          a.activityStatus,
          a.inactiveDays ?? '',
          iso(a.lastOutgoingAt),
          iso(a.lastActivityAt),
          iso(a.lastScannedAt),
        ]
        const tail = [
          a.authorizationStatus,
          a.recoveryStatus,
          a.reviewNote ?? '',
          iso(a.archivedAt),
        ]
        if (a.balances.length === 0) {
          rows.push([...common, '', '', '', fiatCurrency, '', '', '', '', ...tail])
          continue
        }
        for (const b of a.balances) {
          const quantity = fromDbAmount(b.quantity)
          const sameCurrency = b.priceSnapshot?.fiatCurrency === fiatCurrency
          rows.push([
            ...common,
            b.asset.symbol,
            fromBaseUnit(quantity, b.asset.decimals),
            quantity.toString(),
            fiatCurrency,
            sameCurrency && b.fiatValue ? b.fiatValue.toFixed(8) : '',
            sameCurrency && b.fiatValue ? String(a.network.isTestnet) : '',
            sameCurrency ? (b.priceSnapshot?.source ?? '') : '',
            sameCurrency ? iso(b.priceSnapshot?.pricedAt ?? null) : '',
            ...tail,
          ])
        }
      }

      await recordAction(deps.audit, actor, meta, {
        action: 'REPORT_EXPORTED',
        resourceType: 'report',
        resourceId: `addresses-${type}`,
        metadata: { addresses: addresses.length, rows: rows.length },
      })
      return { csv: toCsv(REPORT_HEADERS, rows), addresses: addresses.length }
    },
  }
}

export type ReportService = ReturnType<typeof createReportService>
