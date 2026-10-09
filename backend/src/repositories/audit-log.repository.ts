import { redactSensitive } from '@da/shared'
import type { AuditLog, AuditResult, Prisma } from '../generated/prisma/client'
import type { Database } from '../lib/prisma'

export interface AuditEntry {
  action: string
  result: AuditResult
  userId?: string | null
  resourceType?: string | null
  resourceId?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  requestId?: string | null
  /** Sanitised with redactSensitive() before it is stored. */
  metadata?: Record<string, unknown>
}

export interface AuditQuery {
  userId?: string
  action?: string
  resourceType?: string
  resourceId?: string
  result?: AuditResult
  /** Any of these actions (e.g. the "sensitive" category). Combined with `action` if both set. */
  actions?: string[]
  /** Only entries after this sequence (e.g. since the last review). */
  afterSequence?: bigint
  /** Inclusive lower / exclusive upper bound on created_at. */
  from?: Date
  to?: Date
  limit?: number
  /** Return entries with sequence lower than this (pagination, newest first). */
  beforeSequence?: bigint
}

/**
 * Insert-only by design: there is deliberately no update or delete method,
 * and the database rejects UPDATE/DELETE/TRUNCATE on audit_logs via trigger.
 */
export function createAuditLogRepository(db: Database) {
  return {
    create(entry: AuditEntry): Promise<AuditLog> {
      return db.auditLog.create({
        data: {
          action: entry.action,
          result: entry.result,
          userId: entry.userId ?? null,
          resourceType: entry.resourceType ?? null,
          resourceId: entry.resourceId ?? null,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
          requestId: entry.requestId ?? null,
          metadata:
            entry.metadata === undefined
              ? undefined
              : (redactSensitive(entry.metadata) as Prisma.InputJsonValue),
        },
      })
    },

    list(query: AuditQuery = {}): Promise<AuditLogWithUser[]> {
      return db.auditLog.findMany({
        where: {
          userId: query.userId,
          action: query.actions
            ? { in: query.actions, ...(query.action ? { equals: query.action } : {}) }
            : query.action,
          resourceType: query.resourceType,
          resourceId: query.resourceId,
          result: query.result,
          createdAt: query.from || query.to ? { gte: query.from, lt: query.to } : undefined,
          sequence:
            query.beforeSequence === undefined && query.afterSequence === undefined
              ? undefined
              : { lt: query.beforeSequence, gt: query.afterSequence },
        },
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { sequence: 'desc' },
        take: Math.min(query.limit ?? 50, 50_000),
      })
    },

    count(query: Pick<AuditQuery, 'actions' | 'afterSequence'>): Promise<number> {
      return db.auditLog.count({
        where: {
          action: query.actions ? { in: query.actions } : undefined,
          sequence: query.afterSequence === undefined ? undefined : { gt: query.afterSequence },
        },
      })
    },

    async latestSequence(): Promise<bigint | null> {
      const row = await db.auditLog.findFirst({
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      })
      return row?.sequence ?? null
    },

    async lastByAction(action: string): Promise<AuditLogWithUser | null> {
      return db.auditLog.findFirst({
        where: { action },
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { sequence: 'desc' },
      })
    },

    async distinctActions(): Promise<string[]> {
      const rows = await db.auditLog.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
      })
      return rows.map((r) => r.action)
    },

    /**
     * Recomputes every row's hash in SQL with the SAME function the insert trigger uses
     * (audit_log_row_hash) and checks each link to the previous row (ADR-025).
     */
    async verifyChain(): Promise<ChainCheck> {
      const [broken] = await db.$queryRaw<Array<{ sequence: bigint; reason: string }>>`
        WITH chain AS (
          SELECT "sequence", "hash", "prev_hash",
                 audit_log_row_hash("sequence", "id", "user_id", "action", "resource_type",
                   "resource_id", "result"::text, "ip_address", "user_agent", "request_id",
                   "metadata", "created_at", "prev_hash") AS expected,
                 lag("hash") OVER (ORDER BY "sequence") AS previous
            FROM "audit_logs"
        )
        SELECT "sequence",
               CASE WHEN "hash" IS DISTINCT FROM expected THEN 'ROW_MODIFIED'
                    ELSE 'LINK_BROKEN' END AS reason
          FROM chain
         WHERE "hash" IS DISTINCT FROM expected
            OR "prev_hash" IS DISTINCT FROM coalesce(previous, repeat('0', 64))
         ORDER BY "sequence"
         LIMIT 1`
      const [head] = await db.$queryRaw<
        Array<{ count: bigint; sequence: bigint | null; hash: string | null }>
      >`
        SELECT (SELECT count(*) FROM "audit_logs") AS count, "sequence", "hash"
          FROM "audit_logs" ORDER BY "sequence" DESC LIMIT 1`
      return {
        ok: broken === undefined,
        checked: Number(head?.count ?? 0n),
        firstBrokenSequence: broken ? broken.sequence.toString() : null,
        reason: broken ? (broken.reason as ChainCheck['reason']) : null,
        headSequence: head?.sequence?.toString() ?? null,
        headHash: head?.hash ?? null,
      }
    },
  }
}

export type AuditLogWithUser = AuditLog & {
  user: { id: string; email: string; name: string } | null
}

export interface ChainCheck {
  ok: boolean
  checked: number
  firstBrokenSequence: string | null
  reason: 'ROW_MODIFIED' | 'LINK_BROKEN' | null
  /** Latest row: record this hash outside the system to detect truncation later. */
  headSequence: string | null
  headHash: string | null
}

export type AuditLogRepository = ReturnType<typeof createAuditLogRepository>
