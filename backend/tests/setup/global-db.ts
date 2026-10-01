import { execFileSync } from 'node:child_process'
import pg from 'pg'
import type { TestProject } from 'vitest/node'
import { loadEnvFile } from '../../src/config/env'

declare module 'vitest' {
  export interface ProvidedContext {
    /** Null when no reachable test database: DB tests are skipped. */
    testDatabaseUrl: string | null
  }
}

function deriveTestUrl(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null
  const url = new URL(databaseUrl)
  url.pathname = `${url.pathname.replace(/^\//, '')}_test`
  return url.toString()
}

/**
 * Prepares a dedicated, disposable test database (never the dev DB):
 * creates it if missing, then `prisma migrate reset` so every run starts from the real migrations.
 */
export default async function setup(project: TestProject): Promise<void> {
  loadEnvFile()
  const testUrl = process.env.TEST_DATABASE_URL || deriveTestUrl(process.env.DATABASE_URL)
  if (!testUrl) {
    project.provide('testDatabaseUrl', null)
    return
  }

  const target = new URL(testUrl)
  const dbName = target.pathname.replace(/^\//, '')
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to reset "${dbName}": test database name must end with "_test"`)
  }

  const admin = new URL(testUrl)
  admin.pathname = '/postgres'
  const client = new pg.Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 2000,
  })
  try {
    await client.connect()
  } catch (error) {
    // pg error messages name the host/user but never include the password.
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[db tests] cannot connect to ${target.host} (${reason}) — skipping DB tests\n`,
    )
    project.provide('testDatabaseUrl', null)
    return
  }

  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`)
  } finally {
    await client.end()
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'reset', '--force'], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  })
  project.provide('testDatabaseUrl', testUrl)
}
