import type { AuditLogRepository } from '../repositories/audit-log.repository'
import type { AuthContext, RequestMeta } from './auth.service'

/** Records a successful domain action performed by an authenticated user. */
export function recordAction(
  audit: AuditLogRepository,
  actor: AuthContext,
  meta: RequestMeta,
  entry: {
    action: string
    resourceType: string
    resourceId: string
    metadata?: Record<string, unknown>
  },
) {
  return audit.create({
    action: entry.action,
    result: 'SUCCESS',
    userId: actor.user.id,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
    metadata: entry.metadata,
  })
}
