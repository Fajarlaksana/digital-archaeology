import { createLogger } from '@da/shared'
import { buildApp } from './app'
import { loadEnvFile, parseEnv, type Env } from './config/env'
import { checkDatabase, createPrismaClient } from './lib/prisma'
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
})
const app = await buildApp({ env, logger, checkDatabase: () => checkDatabase(db), services })

if (env.NETWORK_MODE === 'mainnet') {
  logger.warn('NETWORK_MODE=mainnet — real assets are at stake')
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'SHUTDOWN')
  await app.close()
  await db.$disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ host: env.BACKEND_HOST, port: env.BACKEND_PORT })
