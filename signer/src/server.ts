import { createLogger } from '@da/shared'
import { buildSignerApp } from './app'
import { loadEnvFile, parseEnv, type SignerEnv } from './config/env'
import { DEFAULT_KDF } from './crypto/kdf'
import { createKeyService } from './keys/key.service'
import { createVaultDatabase, createVaultRepository } from './vault/vault.repository'
import { createVaultService } from './vault/vault.service'

loadEnvFile()

let env: SignerEnv
try {
  env = parseEnv(process.env)
} catch (error) {
  createLogger({ name: 'signer' }).fatal({ err: error }, 'CONFIG_INVALID')
  process.exit(1)
}

const logger = createLogger({ name: 'signer', level: env.LOG_LEVEL })
const db = createVaultDatabase(env.VAULT_DATABASE_URL)
const repo = createVaultRepository(db)
const vault = createVaultService({
  repo,
  logger,
  unlockTtlMs: env.VAULT_UNLOCK_TTL_MINUTES * 60_000,
  kdf: DEFAULT_KDF,
})
const keys = createKeyService({
  db,
  repo,
  vault,
  logger,
  revealEnabled: env.KEY_REVEAL_ENABLED === 'true',
})
const app = await buildSignerApp({ logger, hmacSecret: env.SIGNER_HMAC_SECRET, vault, keys })

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'SHUTDOWN')
  vault.shutdown() // wipe the master key before anything else
  await app.close()
  await db.$disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
// Last line of defence: never leave a master key in memory on a crash.
process.on('uncaughtException', (err) => {
  vault.shutdown()
  logger.fatal({ err }, 'UNCAUGHT_EXCEPTION')
  process.exit(1)
})

await app.listen({ host: env.SIGNER_HOST, port: env.SIGNER_PORT })
