import { createSecretBox } from '../auth/secret-box'
import type { Database } from '../lib/prisma'
import { createAuditLogRepository } from '../repositories/audit-log.repository'
import { createSessionRepository } from '../repositories/session.repository'
import { createUserRepository } from '../repositories/user.repository'
import { createAuthService } from './auth.service'
import { createUserService } from './user.service'

export interface ServiceConfig {
  mfaEncryptionKey: string
  sessionTtlMs: number
  sessionIdleMs: number
  now?: () => Date
}

/** Wires repositories and services. The single place where the dependency graph is built. */
export function createServices(db: Database, config: ServiceConfig) {
  const now = config.now ?? (() => new Date())
  const users = createUserRepository(db)
  const sessions = createSessionRepository(db)
  const audit = createAuditLogRepository(db)

  return {
    now,
    audit,
    auth: createAuthService({
      users,
      sessions,
      audit,
      secretBox: createSecretBox(config.mfaEncryptionKey),
      sessionTtlMs: config.sessionTtlMs,
      sessionIdleMs: config.sessionIdleMs,
      now,
    }),
    users: createUserService({ users, sessions, audit, now }),
  }
}

export type AppServices = ReturnType<typeof createServices>
