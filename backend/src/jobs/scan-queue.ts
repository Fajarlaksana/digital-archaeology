import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import type { Logger } from '@da/shared'

const QUEUE_NAME = 'scans'

/**
 * BullMQ queue + in-process worker for scans. One scan at a time (concurrency 1) keeps us
 * well inside RPC / explorer rate limits. A stalled job (process crash) is retried once;
 * the scan processor is idempotent and resumes where it stopped.
 */
export function createScanQueue(options: {
  redisUrl: string
  process: (scanId: string) => Promise<void>
  logger: Logger
}) {
  // BullMQ needs dedicated connections, and maxRetriesPerRequest=null for the blocking worker.
  const connection = () => new Redis(options.redisUrl, { maxRetriesPerRequest: null })

  const queue = new Queue(QUEUE_NAME, {
    connection: connection(),
    defaultJobOptions: { attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 },
  })
  const worker = new Worker(QUEUE_NAME, (job) => options.process(String(job.data.scanId)), {
    connection: connection(),
    concurrency: 1,
  })
  worker.on('failed', (job, err) =>
    options.logger.error({ err, scanId: job?.data.scanId }, 'SCAN_JOB_FAILED'),
  )
  worker.on('error', (err) => options.logger.error({ err }, 'SCAN_WORKER_ERROR'))

  return {
    async enqueue(scanId: string): Promise<void> {
      // jobId = scanId: enqueueing the same scan twice is a no-op.
      await queue.add('scan', { scanId }, { jobId: scanId })
    },
    async close(): Promise<void> {
      await worker.close()
      await queue.close()
    },
  }
}
