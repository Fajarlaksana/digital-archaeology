import { fromBaseUnit } from '../domain/money'
import { toCsv } from '../lib/csv'
import type { Database } from '../lib/prisma'
import { fromDbAmount } from '../repositories/amount'
import type { AuditLogRepository } from '../repositories/audit-log.repository'
import { recordAction } from './audit-trail'
import type { AuthContext, RequestMeta } from './auth.service'

/**
 * Balance, Authorization and Transaction reports (SA 21 items 3, 4, 6; Phase 12, ADR-025).
 * Column prefixes keep the kinds of data apart (SA 13):
 *   chain_*    public blockchain data
 *   estimate_* valuations (testnet = simulated)
 *   auth_*     authorization / ownership data
 *   status_*   internal workflow status
 */
export const MAX_REPORT_ROWS = 50_000

export const BALANCE_REPORT_HEADERS = [
  'address',
  'network',
  'label',
  'owner_reference',
  'asset',
  'chain_contract_address',
  'chain_balance',
  'chain_balance_base_units',
  'chain_last_activity_at',
  'chain_scanned_at',
  'estimate_currency',
  'estimate_value',
  'estimate_simulated',
  'estimate_price_source',
  'estimate_priced_at',
  'status_activity',
  'status_recovery',
] as const

export const AUTHORIZATION_REPORT_HEADERS = [
  'address',
  'network',
  'label',
  'owner_reference',
  'auth_type',
  'auth_reference',
  'auth_status',
  'auth_document_name',
  'auth_document_sha256',
  'auth_verified_at',
  'auth_expires_at',
  'auth_last_challenge_result',
  'auth_last_challenge_method',
  'auth_last_challenge_at',
  'status_address_authorization',
  'status_created_at',
] as const

export const TRANSACTION_REPORT_HEADERS = [
  'status_transaction_id',
  'status',
  'status_reason',
  'network',
  'address',
  'asset',
  'destination_label',
  'chain_destination_address',
  'chain_amount',
  'chain_amount_base_units',
  'status_sweep',
  'chain_nonce',
  'chain_max_fee_base_units',
  'chain_fee_paid_base_units',
  'chain_tx_hash',
  'chain_block_number',
  'chain_confirmations',
  'chain_explorer_url',
  'estimate_currency',
  'estimate_value',
  'estimate_simulated',
  'status_created_by',
  'status_created_at',
  'status_approved_by',
  'status_approved_at',
  'status_broadcast_at',
  'status_confirmed_at',
] as const

const iso = (d: Date | null | undefined) => d?.toISOString() ?? ''

export function createOperationalReports(deps: {
  db: Database
  audit: AuditLogRepository
  fiatCurrency: string
}) {
  const { db, fiatCurrency } = deps

  async function exported(
    actor: AuthContext,
    meta: RequestMeta,
    report: string,
    rows: number,
    filter: Record<string, unknown> = {},
  ) {
    await recordAction(deps.audit, actor, meta, {
      action: 'REPORT_EXPORTED',
      resourceType: 'report',
      resourceId: report,
      metadata: { rows, filter },
    })
  }

  return {
    async balancesCsv(actor: AuthContext, filter: { networkId?: string }, meta: RequestMeta) {
      const balances = await db.balance.findMany({
        where: { address: { archivedAt: null, networkId: filter.networkId } },
        include: {
          asset: true,
          priceSnapshot: true,
          address: { include: { network: true } },
        },
        orderBy: [{ address: { network: { name: 'asc' } } }, { address: { address: 'asc' } }],
        take: MAX_REPORT_ROWS,
      })
      const rows = balances.map((b) => {
        const quantity = fromDbAmount(b.quantity)
        const priced = b.priceSnapshot?.fiatCurrency === fiatCurrency && b.fiatValue !== null
        return [
          b.address.address,
          b.address.network.name,
          b.address.label ?? '',
          b.address.ownerReference,
          b.asset.symbol,
          b.asset.contractAddress ?? '',
          fromBaseUnit(quantity, b.asset.decimals),
          quantity.toString(),
          iso(b.address.lastActivityAt),
          iso(b.address.lastScannedAt),
          fiatCurrency,
          priced ? b.fiatValue!.toFixed(8) : '',
          priced ? String(b.address.network.isTestnet) : '',
          priced ? (b.priceSnapshot?.source ?? '') : '',
          priced ? iso(b.priceSnapshot?.pricedAt) : '',
          b.address.activityStatus,
          b.address.recoveryStatus,
        ]
      })
      await exported(actor, meta, 'balances', rows.length, filter)
      return toCsv(BALANCE_REPORT_HEADERS, rows)
    },

    async authorizationsCsv(actor: AuthContext, filter: { networkId?: string }, meta: RequestMeta) {
      const authorizations = await db.authorization.findMany({
        where: { address: { networkId: filter.networkId } },
        include: {
          address: { include: { network: true } },
          challenges: { orderBy: { issuedAt: 'desc' }, take: 1 },
        },
        orderBy: [{ address: { address: 'asc' } }, { createdAt: 'asc' }],
        take: MAX_REPORT_ROWS,
      })
      const now = new Date()
      const rows = authorizations.map((a) => {
        const last = a.challenges[0]
        const expired = a.expiresAt !== null && a.expiresAt <= now
        return [
          a.address.address,
          a.address.network.name,
          a.address.label ?? '',
          a.address.ownerReference,
          a.type,
          a.reference,
          expired ? 'EXPIRED' : a.verificationStatus,
          a.documentName ?? '',
          a.documentSha256 ?? '',
          iso(a.verifiedAt),
          iso(a.expiresAt),
          last?.result ?? '',
          last?.method ?? '',
          iso(last?.issuedAt),
          a.address.authorizationStatus,
          iso(a.createdAt),
        ]
      })
      await exported(actor, meta, 'authorizations', rows.length, filter)
      return toCsv(AUTHORIZATION_REPORT_HEADERS, rows)
    },

    async transactionsCsv(
      actor: AuthContext,
      filter: { networkId?: string; from?: Date; to?: Date },
      meta: RequestMeta,
    ) {
      const transactions = await db.transaction.findMany({
        where: {
          networkId: filter.networkId,
          createdAt: filter.from || filter.to ? { gte: filter.from, lt: filter.to } : undefined,
        },
        include: {
          address: true,
          asset: true,
          destination: true,
          network: true,
          createdBy: { select: { email: true } },
          approvals: {
            where: { decision: 'APPROVED' },
            include: { decidedBy: { select: { email: true } } },
            take: 1,
          },
        },
        orderBy: { createdAt: 'asc' },
        take: MAX_REPORT_ROWS,
      })
      const rows = transactions.map((t) => {
        const amount = fromDbAmount(t.amount)
        const approval = t.approvals[0]
        const explorer =
          t.txHash && t.network.explorerUrl
            ? `${t.network.explorerUrl.replace(/\/$/, '')}/tx/${t.txHash}`
            : ''
        return [
          t.id,
          t.status,
          t.statusReason ?? '',
          t.network.name,
          t.address.address,
          t.asset.symbol,
          t.destination.label,
          t.destination.address,
          fromBaseUnit(amount, t.asset.decimals),
          amount.toString(),
          String(t.sweep),
          t.nonce ?? '',
          t.networkFee === null ? '' : fromDbAmount(t.networkFee).toString(),
          t.feePaid === null ? '' : fromDbAmount(t.feePaid).toString(),
          t.txHash ?? '',
          t.blockNumber?.toString() ?? '',
          t.confirmations,
          explorer,
          fiatCurrency,
          t.estimatedValue?.toFixed(8) ?? '',
          t.estimatedValue === null ? '' : String(t.valueSimulated),
          t.createdBy.email,
          iso(t.createdAt),
          approval?.decidedBy?.email ?? '',
          iso(approval?.decidedAt),
          iso(t.broadcastAt),
          iso(t.confirmedAt),
        ]
      })
      await exported(actor, meta, 'transactions', rows.length, {
        networkId: filter.networkId,
        from: filter.from?.toISOString(),
        to: filter.to?.toISOString(),
      })
      return toCsv(TRANSACTION_REPORT_HEADERS, rows)
    },
  }
}

export type OperationalReports = ReturnType<typeof createOperationalReports>
