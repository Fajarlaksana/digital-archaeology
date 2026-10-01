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

    list(query: AuditQuery = {}): Promise<AuditLog[]> {
      return db.auditLog.findMany({
        where: {
          userId: query.userId,
          action: query.action,
          resourceType: query.resourceType,
          resourceId: query.resourceId,
          sequence: query.beforeSequence === undefined ? undefined : { lt: query.beforeSequence },
        },
        orderBy: { sequence: 'desc' },
        take: Math.min(query.limit ?? 50, 500),
      })
    },
  }
}

export type AuditLogRepository = ReturnType<typeof createAuditLogRepository>
