import { createLogger } from '@da/shared'
import { buildApp } from './app'
import { isLoopbackHost, loadEnvFile, parseEnv, type Env } from './config/env'
import { checkDatabase, createPrismaClient } from './lib/prisma'
import { createChainClientFactory } from './chains/clients'
import { createMaintenanceQueue } from './jobs/maintenance-queue'
import { createScanQueue } from './jobs/scan-queue'
import { createCoinGeckoProvider } from './pricing/coingecko'
import { createHttpSignerClient } from './signer/client'
import { createServices } from './services'

loadEnvFile()

let env: Env
try {
  env = parseEnv(process.env)
} catch (error) {
  createLogger({ name: 'backend' }).fatal({ err: error }, 'CONFIG_INVALID')
  process.exit(1)
}

const logger = createLogger({ name: 'backend', level: env.LOG_LEVEL })
const db = createPrismaClient(env.DATABASE_URL)
const services = createServices(db, {
  mfaEncryptionKey: env.MFA_ENCRYPTION_KEY,
  sessionTtlMs: env.SESSION_TTL_HOURS * 3_600_000,
  sessionIdleMs: env.SESSION_IDLE_MINUTES * 60_000,
  networkMode: env.NETWORK_MODE,
  clientsFor: createChainClientFactory({
    explorerApiKey: env.EXPLORER_API_KEY,
    explorerApiUrl: env.EXPLORER_API_URL,
    explorerRatePerSecond: env.EXPLORER_RATE_LIMIT_PER_SECOND,
    readEnv: (name) => process.env[name] || undefined,
  }),
  enqueueScan: (scanId) => scanQueue.enqueue(scanId),
  defaultThresholdDays: env.INACTIVITY_THRESHOLD_DAYS,
  logger,
  priceProvider: createCoinGeckoProvider({ baseUrl: env.PRICE_API_URL, apiKey: env.PRICE_API_KEY }),
  fiatCurrency: env.FIAT_CURRENCY,
  scheduleInfo: () => maintenance.info(),
  signer: createHttpSignerClient({ baseUrl: env.SIGNER_URL, secret: env.SIGNER_HMAC_SECRET }),
  challengeTtlMs: env.CHALLENGE_TTL_MINUTES * 60_000,
  minNetValue: env.RECOVERY_MIN_NET_VALUE,
  feeMarginPercent: env.FEE_MARGIN_PERCENT,
  balanceMaxAgeMs: env.ELIGIBILITY_BALANCE_MAX_AGE_HOURS * 3_600_000,
  approvalTtlMs: env.APPROVAL_TTL_MINUTES * 60_000,
  txConfirmations: env.TX_CONFIRMATIONS,
  txStuckMs: env.TX_STUCK_MINUTES * 60_000,
})
const scanQueue = createScanQueue({
  redisUrl: env.REDIS_URL,
  process: (scanId) => services.scans.process(scanId),
  logger,
})
const maintenance = createMaintenanceQueue({
  redisUrl: env.REDIS_URL,
  logger,
  priceIntervalMinutes: env.PRICE_UPDATE_INTERVAL_MINUTES,
  scanCron: env.SCAN_SCHEDULE_CRON,
  timezone: env.SCHEDULER_TIMEZONE,
  updatePrices: () => services.valuation.updatePrices(),
  startScheduledScans: () => services.scans.startScheduledScans(),
  txCheckIntervalSeconds: env.TX_CHECK_INTERVAL_SECONDS,
  checkPendingTransactions: () => services.transactions.checkInFlight(),
})
const app = await buildApp({ env, logger, checkDatabase: () => checkDatabase(db), services })

if (env.NETWORK_MODE === 'mainnet') {
  logger.warn('NETWORK_MODE=mainnet — real assets are at stake')
}
const signerUrl = new URL(env.SIGNER_URL)
if (signerUrl.protocol === 'http:' && !isLoopbackHost(signerUrl.hostname)) {
  // Only reachable with SIGNER_ALLOW_INSECURE_HTTP=true. Host only: never log the full URL.
  logger.warn(
    { signerHost: signerUrl.hostname },
    'SIGNER_INSECURE_HTTP — vault passphrases travel unencrypted to the signer',
  )
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'SHUTDOWN')
  await app.close()
  await scanQueue.close()
  await maintenance.close()
  await db.$disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await maintenance.start()
await app.listen({ host: env.BACKEND_HOST, port: env.BACKEND_PORT })
