import { existsSync } from 'node:fs'
import { defineConfig } from 'prisma/config'

// Dev convenience: the repository-root .env. In production the signer gets its OWN env,
// and VAULT_DATABASE_URL is never given to the backend (ADR-008).
const rootEnv = new URL('../.env', import.meta.url)
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.VAULT_DATABASE_URL },
})
