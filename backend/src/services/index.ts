import { createSecretBox } from '../auth/secret-box'
import type { Database } from '../lib/prisma'
import { createAddressRepository } from '../repositories/address.repository'
import { createAuditLogRepository } from '../repositories/audit-log.repository'
import { createNetworkRepository } from '../repositories/network.repository'
import { createSessionRepository } from '../repositories/session.repository'
import { createUserRepository } from '../repositories/user.repository'
import { createAddressService } from './address.service'
import { createAuthService } from './auth.service'
import { createNetworkService } from './network.service'
import { createUserService } from './user.service'

export interface ServiceConfig {
  mfaEncryptionKey: string
  sessionTtlMs: number
  sessionIdleMs: number
  networkMode: 'testnet' | 'mainnet'
  now?: () => Date
  /** Defaults to checking process.env. */
  isEnvSet?: (name: string) => boolean
}

/** Wires repositories and services. The single place where the dependency graph is built. */
export function createServices(db: Database, config: ServiceConfig) {
  const now = config.now ?? (() => new Date())
  const users = createUserRepository(db)
  const sessions = createSessionRepository(db)
  const audit = createAuditLogRepository(db)
  const networks = createNetworkRepository(db)
  const addresses = createAddressRepository(db)
  const isEnvSet = config.isEnvSet ?? ((name: string) => Boolean(process.env[name]))

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
    networks: createNetworkService({ networks, audit, networkMode: config.networkMode, isEnvSet }),
    addresses: createAddressService({ addresses, networks, audit, now }),
  }
}

export type AppServices = ReturnType<typeof createServices>
