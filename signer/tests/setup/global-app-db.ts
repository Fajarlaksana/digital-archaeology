import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import pg from 'pg'
import type { TestProject } from 'vitest/node'
import { loadEnvFile } from '../../src/config/env'

declare module 'vitest' {
  export interface ProvidedContext {
    /** Owner connection to a throw-away APPLICATION database (fixtures are inserted with it). */
    testAppDatabaseUrl: string | null
    /** The same database through the signer's read-only login (da_signer_ro). */
    testAppReadonlyUrl: string | null
  }
}

const require = createRequire(import.meta.url)
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js')
const BACKEND_DIR = resolve(import.meta.dirname, '../../../backend')

/**
 * Transaction signing reads approvals from the application DB (ADR-023). This creates a fresh,
 * uniquely named application database with the backend's real migrations (which grant the
 * read-only role its columns) and drops exactly that database afterwards.
 * Skipped when DATABASE_URL / APP_DATABASE_URL_READONLY are missing or unreachable.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const noop = async () => {}
  const skip = (why: string) => {
    process.stderr.write(`[signer app-db tests] ${why} — skipping transaction-signing DB tests\n`)
    project.provide('testAppDatabaseUrl', null)
    project.provide('testAppReadonlyUrl', null)
    return noop
  }
  loadEnvFile()
  const ownerBase = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  const readonlyBase = process.env.APP_DATABASE_URL_READONLY
  if (!ownerBase || !readonlyBase) return skip('DATABASE_URL or APP_DATABASE_URL_READONLY not set')

  const server = new URL(ownerBase)
  const dbName = `${server.pathname.replace(/^\//, '') || 'app'}_signer_test_${Date.now()}_${randomBytes(3).toString('hex')}`
  const admin = new URL(server)
  admin.pathname = '/postgres'
  const client = new pg.Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 2000,
  })
  try {
    await client.connect()
  } catch (error) {
    return skip(
      `cannot connect to ${server.host} (${error instanceof Error ? error.message : error})`,
    )
  }
  try {
    const role = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'da_signer_ro'`)
    if (role.rowCount === 0) return skip('role da_signer_ro does not exist')
    await client.query(`CREATE DATABASE "${dbName}"`)
  } finally {
    await client.end()
  }

  const ownerUrl = new URL(server)
  ownerUrl.pathname = `/${dbName}`
  execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: ownerUrl.toString() },
    stdio: 'pipe',
  })
  const readonlyUrl = new URL(readonlyBase)
  readonlyUrl.pathname = `/${dbName}`
  project.provide('testAppDatabaseUrl', ownerUrl.toString())
  project.provide('testAppReadonlyUrl', readonlyUrl.toString())

  return async () => {
    const cleanup = new pg.Client({ connectionString: admin.toString() })
    await cleanup.connect()
    try {
      // Only ever drops the database created above in this same run.
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    } finally {
      await cleanup.end()
    }
  }
}
