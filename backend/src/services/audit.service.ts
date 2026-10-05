import type { Logger } from '@da/shared'
import type { AuditResult } from '../generated/prisma/client'
import { toCsv } from '../lib/csv'
import type {
  AuditLogRepository,
  AuditLogWithUser,
  AuditQuery,
  ChainCheck,
} from '../repositories/audit-log.repository'
import { recordAction } from './audit-trail'
import type { AuthContext, RequestMeta } from './auth.service'

export interface AuditFilter {
  action?: string
  userId?: string
  result?: AuditResult
  resourceType?: string
  resourceId?: string
  from?: Date
  to?: Date
}

export interface PublicAuditEntry {
  sequence: string
  createdAt: string
  user: { id: string; email: string; name: string } | null
  action: string
  result: AuditResult
  resourceType: string | null
  resourceId: string | null
  ipAddress: string | null
  userAgent: string | null
  requestId: string | null
  /** Already redacted when written (redactSensitive). */
  metadata: unknown
  hash: string | null
  prevHash: string | null
}

const PAGE = 50
/** Upper bound for one audit export; narrow the filter for more. */
export const MAX_AUDIT_EXPORT = 50_000

export const AUDIT_REPORT_HEADERS = [
  'status_sequence',
  'status_created_at',
  'status_user_email',
  'status_action',
  'status_result',
  'status_resource_type',
  'status_resource_id',
  'status_ip_address',
  'status_request_id',
  'status_metadata_json',
  'status_hash',
  'status_prev_hash',
] as const

function toPublic(e: AuditLogWithUser): PublicAuditEntry {
  return {
    sequence: e.sequence.toString(),
    createdAt: e.createdAt.toISOString(),
    user: e.user,
    action: e.action,
    result: e.result,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    ipAddress: e.ipAddress,
    userAgent: e.userAgent,
    requestId: e.requestId,
    metadata: e.metadata,
    hash: e.hash,
    prevHash: e.prevHash,
  }
}

/** Read-only access to the audit trail for AUDITOR (Phase 12, ADR-025). */
export function createAuditService(deps: { audit: AuditLogRepository; logger: Logger }) {
  const { audit } = deps
  const query = (filter: AuditFilter): AuditQuery => ({ ...filter })

  return {
    /** Newest first; `before` is the sequence of the last row of the previous page. */
    async list(filter: AuditFilter & { before?: string; limit?: number }) {
      const limit = Math.min(filter.limit ?? PAGE, 200)
      const rows = await audit.list({
        ...query(filter),
        beforeSequence: filter.before === undefined ? undefined : BigInt(filter.before),
        limit: limit + 1,
      })
      const page = rows.slice(0, limit)
      return {
        items: page.map(toPublic),
        nextBefore: rows.length > limit ? page[page.length - 1]!.sequence.toString() : null,
      }
    },

    actions: () => audit.distinctActions(),

    async verify(actor: AuthContext, meta: RequestMeta): Promise<ChainCheck> {
      const check = await audit.verifyChain()
      if (!check.ok) {
        deps.logger.error(
          { firstBrokenSequence: check.firstBrokenSequence, reason: check.reason },
          'AUDIT_CHAIN_BROKEN',
        )
      }
      await recordAction(audit, actor, meta, {
        action: 'AUDIT_CHAIN_VERIFIED',
        resourceType: 'audit',
        resourceId: 'audit_logs',
        metadata: { ...check },
      })
      return check
    },

    async csv(actor: AuthContext, filter: AuditFilter, meta: RequestMeta) {
      const rows = await audit.list({ ...query(filter), limit: MAX_AUDIT_EXPORT })
      const csv = toCsv(
        AUDIT_REPORT_HEADERS,
        rows.map((e) => [
          e.sequence.toString(),
          e.createdAt.toISOString(),
          e.user?.email ?? '',
          e.action,
          e.result,
          e.resourceType ?? '',
          e.resourceId ?? '',
          e.ipAddress ?? '',
          e.requestId ?? '',
          e.metadata === null ? '' : JSON.stringify(e.metadata),
          e.hash ?? '',
          e.prevHash ?? '',
        ]),
      )
      await recordAction(audit, actor, meta, {
        action: 'REPORT_EXPORTED',
        resourceType: 'report',
        resourceId: 'audit',
        metadata: {
          rows: rows.length,
          filter: { ...filter, from: filter.from?.toISOString(), to: filter.to?.toISOString() },
        },
      })
      return csv
    },
  }
}

export type AuditService = ReturnType<typeof createAuditService>
