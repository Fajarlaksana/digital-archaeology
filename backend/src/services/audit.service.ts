import { AppError, type Logger } from '@da/shared'
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

/**
 * Actions an AUDITOR reviews periodically (Phase 13b, ADR-027): key custody, money movement,
 * access changes and refusals. The review procedure is in docs/06-manual-guide.md §12.
 */
export const SENSITIVE_ACTIONS = [
  'VAULT_INITIALIZED',
  'VAULT_UNLOCKED',
  'VAULT_UNLOCKED_FAILED',
  'VAULT_PASSPHRASE_CHANGED',
  'VAULT_RECOVERED',
  'KEY_IMPORTED',
  'KEY_REVEALED',
  'KEY_REVEALED_FAILED',
  'DESTINATION_APPROVED',
  'DESTINATION_DISABLED',
  'TRANSACTION_APPROVED',
  'TX_SIGNED',
  'TX_SIGNATURE_REJECTED',
  'TX_BROADCASTED',
  'TX_BROADCAST_FAILED',
  'TX_FAILED',
  'TX_STUCK',
  'USER_CREATED',
  'USER_UPDATED',
  'MFA_RESET',
  'MFA_RESET_CLI',
  'USER_CREATED_CLI',
  'ACCOUNT_LOCKED',
  'ACCESS_DENIED',
  'SESSION_REVOKED_MFA_ATTEMPTS',
  'AUDIT_CHAIN_VERIFIED',
]

export interface AuditFilter {
  /** "sensitive" = SENSITIVE_ACTIONS only. */
  category?: 'sensitive'
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
  const query = ({ category, ...filter }: AuditFilter): AuditQuery => ({
    ...filter,
    actions: category === 'sensitive' ? SENSITIVE_ACTIONS : undefined,
  })

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

    /** The last periodic review and how much sensitive activity happened since. */
    async reviewStatus() {
      const last = await audit.lastByAction('AUDIT_REVIEWED')
      const upTo = last
        ? BigInt(String((last.metadata as { upToSequence?: string })?.upToSequence ?? '0'))
        : null
      return {
        lastReview: last
          ? {
              at: last.createdAt.toISOString(),
              by: last.user,
              upToSequence: upTo!.toString(),
              note: (last.metadata as { note?: string })?.note ?? null,
            }
          : null,
        sensitiveSince: await audit.count({
          actions: SENSITIVE_ACTIONS,
          afterSequence: upTo ?? undefined,
        }),
        latestSequence: (await audit.latestSequence())?.toString() ?? null,
      }
    },

    /**
     * Records that the AUDITOR reviewed everything up to `upToSequence`; the integrity check
     * runs at the same moment and its result is part of the record.
     */
    async markReviewed(
      actor: AuthContext,
      input: { upToSequence: string; note: string },
      meta: RequestMeta,
    ) {
      const upTo = BigInt(input.upToSequence)
      const latest = await audit.latestSequence()
      if (latest === null || upTo > latest) {
        throw new AppError('VALIDATION_ERROR', 'upToSequence is beyond the latest audit entry')
      }
      const previous = await audit.lastByAction('AUDIT_REVIEWED')
      const previousUpTo = previous
        ? BigInt(String((previous.metadata as { upToSequence?: string })?.upToSequence ?? '0'))
        : null
      if (previousUpTo !== null && upTo <= previousUpTo) {
        throw new AppError('CONFLICT', `Already reviewed up to #${previousUpTo}`)
      }
      const chain = await audit.verifyChain()
      const reviewedSensitive = await audit.count({
        actions: SENSITIVE_ACTIONS,
        afterSequence: previousUpTo ?? undefined,
      })
      await recordAction(audit, actor, meta, {
        action: 'AUDIT_REVIEWED',
        resourceType: 'audit',
        resourceId: input.upToSequence,
        metadata: {
          upToSequence: input.upToSequence,
          fromSequence: previousUpTo?.toString() ?? null,
          note: input.note,
          reviewedSensitive,
          chainOk: chain.ok,
          headSequence: chain.headSequence,
          headHash: chain.headHash,
        },
      })
      return { chain, reviewedSensitive }
    },

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
