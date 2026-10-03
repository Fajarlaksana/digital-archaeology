import type { Logger } from '@da/shared'
import { createSecretBox } from '../auth/secret-box'
import type { ChainClientFactory } from '../chains/clients'
import type { Database } from '../lib/prisma'
import type { PriceProvider } from '../pricing/coingecko'
import type { SignerClient } from '../signer/client'
import { createAddressRepository } from '../repositories/address.repository'
import { createAuditLogRepository } from '../repositories/audit-log.repository'
import { createAuthorizationRepository } from '../repositories/authorization.repository'
import { createNetworkRepository } from '../repositories/network.repository'
import { createPriceRepository } from '../repositories/price.repository'
import { createScanRepository } from '../repositories/scan.repository'
import { createSessionRepository } from '../repositories/session.repository'
import { createUserRepository } from '../repositories/user.repository'
import { createAddressService } from './address.service'
import { createAuthService } from './auth.service'
import { createChainHealth } from './chain-health'
import { createDashboardService, type ScheduleInfo } from './dashboard.service'
import { createNetworkService } from './network.service'
import { createOwnershipService } from './ownership.service'
import { createReportService } from './report.service'
import { createScanService } from './scan.service'
import { createUserService } from './user.service'
import { createValuationService } from './valuation.service'
import { createVaultService } from './vault.service'

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
  /** Phase 6 */
  priceProvider: PriceProvider
  fiatCurrency: string
  /** Scheduler state for the dashboard; null when no scheduler runs (tests). */
  scheduleInfo?: () => Promise<ScheduleInfo | null>
  /** Phase 7: the internal signer (HTTP + HMAC in the server, in-memory fake in tests). */
  signer: SignerClient
  /** Ownership challenge lifetime (default 15 min). */
  challengeTtlMs?: number
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
  const fiatCurrency = config.fiatCurrency

  const valuation = createValuationService({
    prices: createPriceRepository(db),
    provider: config.priceProvider,
    audit,
    fiatCurrency,
    logger: config.logger,
  })

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
    addresses: createAddressService({ addresses, networks, audit, fiatCurrency, now }),
    scans: createScanService({
      scans: createScanRepository(db),
      networks,
      audit,
      clientsFor: config.clientsFor,
      enqueue: config.enqueueScan,
      defaultThresholdDays: config.defaultThresholdDays,
      logger: config.logger,
      fiatCurrency,
      now,
      // New balances get the latest stored prices right away (no wait for the next price job).
      afterScan: async (networkId) => {
        await valuation.revalueNetwork(networkId)
      },
    }),
    valuation,
    dashboard: createDashboardService({
      db,
      fiatCurrency,
      scheduleInfo: config.scheduleInfo ?? (async () => null),
    }),
    reports: createReportService({ db, audit, fiatCurrency }),
    vault: createVaultService({ signer: config.signer, addresses, audit, logger: config.logger }),
    ownership: createOwnershipService({
      authorizations: createAuthorizationRepository(db),
      signer: config.signer,
      audit,
      logger: config.logger,
      challengeTtlMs: config.challengeTtlMs ?? 15 * 60_000,
      now,
    }),
    checkRpc: createChainHealth({ networks, clientsFor: config.clientsFor }),
  }
}

export type AppServices = ReturnType<typeof createServices>
