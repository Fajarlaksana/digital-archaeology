import type { Logger } from '@da/shared'
import { createSecretBox } from '../auth/secret-box'
import type { ChainClientFactory } from '../chains/clients'
import type { Database } from '../lib/prisma'
import { createAddressRepository } from '../repositories/address.repository'
import { createAuditLogRepository } from '../repositories/audit-log.repository'
import { createNetworkRepository } from '../repositories/network.repository'
import { createScanRepository } from '../repositories/scan.repository'
import { createSessionRepository } from '../repositories/session.repository'
import { createUserRepository } from '../repositories/user.repository'
import { createAddressService } from './address.service'
import { createAuthService } from './auth.service'
import { createChainHealth } from './chain-health'
import { createNetworkService } from './network.service'
import { createScanService } from './scan.service'
import { createUserService } from './user.service'

export interface ServiceConfig {
  mfaEncryptionKey: string
  sessionTtlMs: number
  sessionIdleMs: number
  networkMode: 'testnet' | 'mainnet'
  now?: () => Date
  /** Defaults to checking process.env. */
  isEnvSet?: (name: string) => boolean
  /** Builds RPC/explorer clients per network (fakes in tests). */
  clientsFor: ChainClientFactory
  /** Hands a scan to the job queue (BullMQ in the server, a spy in tests). */
  enqueueScan: (scanId: string) => Promise<void>
  defaultThresholdDays: number
  logger: Logger
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
    scans: createScanService({
      scans: createScanRepository(db),
      networks,
      audit,
      clientsFor: config.clientsFor,
      enqueue: config.enqueueScan,
      defaultThresholdDays: config.defaultThresholdDays,
      logger: config.logger,
      now,
    }),
    checkRpc: createChainHealth({ networks, clientsFor: config.clientsFor }),
  }
}

export type AppServices = ReturnType<typeof createServices>
