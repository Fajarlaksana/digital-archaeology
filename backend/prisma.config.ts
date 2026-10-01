import { existsSync } from 'node:fs'
import { defineConfig } from 'prisma/config'

// Single source of env vars: the repository-root .env (same file the backend reads).
const rootEnv = new URL('../.env', import.meta.url)
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
