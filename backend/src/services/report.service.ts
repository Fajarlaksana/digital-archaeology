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

/** Eligibility report (Phase 8b, SA 21 item 5): one row per evaluated asset. */
export const ELIGIBILITY_REPORT_HEADERS = [
  'address',
  'network',
  'label',
  'owner_reference',
  'activity_status',
  'authorization_status',
  'recovery_status',
  'recovery_reasons',
  'asset',
  'balance',
  'balance_base_units',
  'eligibility_status',
  'eligibility_reason',
  'fiat_currency',
  'estimated_value',
  'estimated_fee_native_base_units',
  'estimated_fee_value',
  'estimated_net_value',
  'value_simulated',
  'evaluated_at',
] as const

export function createEligibilityReport(deps: {
  db: Database
  audit: AuditLogRepository
  fiatCurrency: string
}) {
  return {
    async csv(actor: AuthContext, meta: RequestMeta) {
      const addresses = await deps.db.address.findMany({
        where: { archivedAt: null, eligibilityCheckedAt: { not: null } },
        include: {
          network: true,
          eligibility: {
            include: { asset: true },
            orderBy: [{ asset: { isNative: 'desc' } }, { asset: { symbol: 'asc' } }],
          },
        },
        orderBy: [{ network: { name: 'asc' } }, { recoveryStatus: 'asc' }, { address: 'asc' }],
        take: MAX_REPORT_ADDRESSES,
      })
      const fixed = (d: { toFixed(n: number): string } | null) => d?.toFixed(8) ?? ''
      const rows: unknown[][] = []
      for (const a of addresses) {
        const common = [
          a.address,
          a.network.name,
          a.label ?? '',
          a.ownerReference,
          a.activityStatus,
          a.authorizationStatus,
          a.recoveryStatus,
          a.recoveryReason ?? '',
        ]
        const evaluatedAt = a.eligibilityCheckedAt?.toISOString() ?? ''
        if (a.eligibility.length === 0) {
          rows.push([
            ...common,
            '',
            '',
            '',
            '',
            '',
            deps.fiatCurrency,
            '',
            '',
            '',
            '',
            '',
            evaluatedAt,
          ])
          continue
        }
        for (const e of a.eligibility) {
          const quantity = fromDbAmount(e.quantity)
          rows.push([
            ...common,
            e.asset.symbol,
            fromBaseUnit(quantity, e.asset.decimals),
            quantity.toString(),
            e.status,
            e.reason ?? '',
            deps.fiatCurrency,
            fixed(e.valueFiat),
            e.feeEstimate === null ? '' : fromDbAmount(e.feeEstimate).toString(),
            fixed(e.feeFiat),
            fixed(e.netFiat),
            String(e.simulated),
            e.computedAt.toISOString(),
          ])
        }
      }
      await recordAction(deps.audit, actor, meta, {
        action: 'REPORT_EXPORTED',
        resourceType: 'report',
        resourceId: 'eligibility',
        metadata: { addresses: addresses.length, rows: rows.length },
      })
      return toCsv(ELIGIBILITY_REPORT_HEADERS, rows)
    },
  }
}
