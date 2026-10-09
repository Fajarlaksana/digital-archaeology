import type { Logger } from '@da/shared'
import { createSecretBox } from '../auth/secret-box'
import type { ChainClientFactory } from '../chains/clients'
import type { Database } from '../lib/prisma'
import type { Notifier } from '../lib/notifier'
import type { RateLimiterFactory } from '../lib/rate-limiter'
import type { PriceProvider } from '../pricing/coingecko'
import type { SignerClient } from '../signer/client'
import { createAddressRepository } from '../repositories/address.repository'
import { createAuditLogRepository } from '../repositories/audit-log.repository'
import { createAuthorizationRepository } from '../repositories/authorization.repository'
import { createDestinationRepository } from '../repositories/destination.repository'
import { createEligibilityRepository } from '../repositories/eligibility.repository'
import { createTransactionRepository } from '../repositories/transaction.repository'
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
import { withAlerts } from './alerts'
import { createAuditService } from './audit.service'
import { createDestinationService } from './destination.service'
import { createMetricsService } from './metrics.service'
import { createOperationalReports } from './operational-reports'
import { createEligibilityService } from './eligibility.service'
import { createTransactionService } from './transaction.service'
import { createOwnershipService } from './ownership.service'
import { createEligibilityReport, createReportService } from './report.service'
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
  /** Eligibility (Phase 8b): minimum net fiat value, fee margin %, max balance age. */
  minNetValue?: string
  feeMarginPercent?: number
  balanceMaxAgeMs?: number
  /** How long a transaction approval stays valid (default 30 min). */
  approvalTtlMs?: number
  /** Security alerts (Telegram) for audited events listed in services/alerts.ts. */
  notifier?: Notifier
  /** Shown in alerts, e.g. "production/testnet". */
  environmentLabel?: string
  /** Login/MFA throttling shared by all API instances (Redis); in-memory when omitted. */
  rateLimiters?: RateLimiterFactory
  /** Mainnet: fiat cap for the first (test) transfer to each destination (default 25). */
  mainnetFirstTransferMax?: string
  /** Phase 11: confirmations before CONFIRMED (default 3) and the STUCK threshold (30 min). */
  txConfirmations?: number
  txStuckMs?: number
}

/** Wires repositories and services. The single place where the dependency graph is built. */
export function createServices(db: Database, config: ServiceConfig) {
  const now = config.now ?? (() => new Date())
  const users = createUserRepository(db)
  const sessions = createSessionRepository(db)
  const plainAudit = createAuditLogRepository(db)
  const audit = config.notifier
    ? withAlerts(plainAudit, {
        notifier: config.notifier,
        environment: config.environmentLabel ?? 'development',
        emailOf: async (id) => (await users.findById(id))?.email ?? null,
        logger: config.logger,
        now,
      })
    : plainAudit
  const networks = createNetworkRepository(db)
  const addresses = createAddressRepository(db)
  const isEnvSet = config.isEnvSet ?? ((name: string) => Boolean(process.env[name]))
  const fiatCurrency = config.fiatCurrency

  const prices = createPriceRepository(db)
  const valuation = createValuationService({
    prices,
    provider: config.priceProvider,
    audit,
    fiatCurrency,
    logger: config.logger,
  })

  const eligibility = createEligibilityService({
    eligibility: createEligibilityRepository(db),
    networks,
    prices,
    signer: config.signer,
    clientsFor: config.clientsFor,
    audit,
    logger: config.logger,
    fiatCurrency,
    minNetValue: config.minNetValue ?? '10',
    feeMarginPercent: config.feeMarginPercent ?? 20,
    balanceMaxAgeMs: config.balanceMaxAgeMs ?? 36 * 3_600_000,
    now,
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
      rateLimiters: config.rateLimiters,
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
        // Fresh balances → fresh eligibility (information only, CLAUDE.md rule 5).
        await eligibility.evaluateNetwork(networkId)
      },
    }),
    valuation,
    dashboard: createDashboardService({
      db,
      fiatCurrency,
      scheduleInfo: config.scheduleInfo ?? (async () => null),
    }),
    reports: createReportService({ db, audit, fiatCurrency }),
    eligibility,
    transactions: createTransactionService({
      transactions: createTransactionRepository(db),
      prices,
      signer: config.signer,
      clientsFor: config.clientsFor,
      audit,
      logger: config.logger,
      fiatCurrency,
      feeMarginPercent: config.feeMarginPercent ?? 20,
      approvalTtlMs: config.approvalTtlMs ?? 30 * 60_000,
      networkMode: config.networkMode,
      mainnetFirstTransferMax: config.mainnetFirstTransferMax ?? '25',
      requiredConfirmations: config.txConfirmations ?? 3,
      stuckAfterMs: config.txStuckMs ?? 30 * 60_000,
      // After a confirmed transfer: re-read the address's balances right away and revalue them.
      afterConfirmed: async ({ addressId, networkId }) => {
        const network = await networks.findById(networkId)
        const address = await addresses.findById(addressId)
        if (!network || !address) return
        const reader = config.clientsFor(network).reader
        for (const asset of network.assets) {
          const quantity = asset.isNative
            ? await reader.getNativeBalance(address.address)
            : await reader.getTokenBalance(address.address, asset.contractAddress!)
          await addresses.upsertBalance(address.id, asset.id, quantity)
        }
        await valuation.revalueNetwork(networkId)
      },
      now,
    }),
    eligibilityReport: createEligibilityReport({ db, audit, fiatCurrency }),
    auditTrail: createAuditService({ audit, logger: config.logger }),
    metrics: createMetricsService({ db }),
    /** Exposed for /health/vault (reachability only). */
    signer: config.signer,
    operationalReports: createOperationalReports({ db, audit, fiatCurrency }),
    vault: createVaultService({ signer: config.signer, addresses, audit, logger: config.logger }),
    ownership: createOwnershipService({
      authorizations: createAuthorizationRepository(db),
      signer: config.signer,
      audit,
      logger: config.logger,
      challengeTtlMs: config.challengeTtlMs ?? 15 * 60_000,
      now,
    }),
    destinations: createDestinationService({
      destinations: createDestinationRepository(db),
      networks,
      audit,
      logger: config.logger,
      challengeTtlMs: config.challengeTtlMs ?? 15 * 60_000,
      now,
    }),
    checkRpc: createChainHealth({ networks, clientsFor: config.clientsFor }),
  }
}

export type AppServices = ReturnType<typeof createServices>
