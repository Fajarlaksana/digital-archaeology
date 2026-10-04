import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import type { Logger } from '@da/shared'
import type { ScheduleInfo } from '../services/dashboard.service'

const QUEUE_NAME = 'maintenance'
const PRICES = 'update-prices'
const SCANS = 'scheduled-scans'
const PENDING_TX = 'check-pending-transactions'

/**
 * Recurring system jobs (Phase 6), driven by BullMQ job schedulers so that only one run happens
 * even with several backend instances:
 *  - update-prices: every N minutes
 *  - scheduled-scans: cron (default daily 02:00), "off" disables
 *  - check-pending-transactions (Phase 11): every N seconds, follows broadcast transactions
 * These jobs only READ the chain; nothing ever moves assets automatically (CLAUDE.md rule 5).
 */
export function createMaintenanceQueue(options: {
  redisUrl: string
  logger: Logger
  priceIntervalMinutes: number
  scanCron: string
  timezone: string
  updatePrices: () => Promise<unknown>
  startScheduledScans: () => Promise<unknown>
  txCheckIntervalSeconds: number
  checkPendingTransactions: () => Promise<unknown>
}) {
  const connection = () => new Redis(options.redisUrl, { maxRetriesPerRequest: null })
  const queue = new Queue(QUEUE_NAME, {
    connection: connection(),
    defaultJobOptions: { attempts: 1, removeOnComplete: 200, removeOnFail: 200 },
  })
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === PRICES) return options.updatePrices()
      if (job.name === SCANS) return options.startScheduledScans()
      if (job.name === PENDING_TX) return options.checkPendingTransactions()
      options.logger.warn({ name: job.name }, 'UNKNOWN_MAINTENANCE_JOB')
      return undefined
    },
    { connection: connection(), concurrency: 1 },
  )
  worker.on('failed', (job, err) =>
    options.logger.error({ err, job: job?.name }, 'MAINTENANCE_JOB_FAILED'),
  )
  worker.on('error', (err) => options.logger.error({ err }, 'MAINTENANCE_WORKER_ERROR'))

  const scansEnabled = options.scanCron !== 'off'

  return {
    async start(): Promise<void> {
      await queue.upsertJobScheduler(
        PRICES,
        { every: options.priceIntervalMinutes * 60_000 },
        { name: PRICES },
      )
      await queue.upsertJobScheduler(
        PENDING_TX,
        { every: options.txCheckIntervalSeconds * 1000 },
        { name: PENDING_TX },
      )
      if (scansEnabled) {
        await queue.upsertJobScheduler(
          SCANS,
          { pattern: options.scanCron, tz: options.timezone },
          { name: SCANS },
        )
      } else {
        await queue.removeJobScheduler(SCANS)
      }
      options.logger.info(
        {
          priceEveryMinutes: options.priceIntervalMinutes,
          scanCron: options.scanCron,
          tz: options.timezone,
        },
        'SCHEDULER_STARTED',
      )
    },

    async info(): Promise<ScheduleInfo> {
      const scheduler = scansEnabled ? await queue.getJobScheduler(SCANS) : undefined
      return {
        scansEnabled,
        scanPattern: scansEnabled ? options.scanCron : null,
        timezone: options.timezone,
        nextScanAt: scheduler?.next ? new Date(scheduler.next).toISOString() : null,
        priceIntervalMinutes: options.priceIntervalMinutes,
      }
    },

    async close(): Promise<void> {
      await worker.close()
      await queue.close()
    },
  }
}
