import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import pg from 'pg'
import type { TestProject } from 'vitest/node'
import { loadEnvFile } from '../../src/config/env'

declare module 'vitest' {
  export interface ProvidedContext {
    /** Null when no reachable database server: DB tests are skipped. */
    testDatabaseUrl: string | null
  }
}

const require = createRequire(import.meta.url)
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js')

function adminClient(serverUrl: URL): pg.Client {
  const admin = new URL(serverUrl)
  admin.pathname = '/postgres'
  return new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 2000 })
}

/**
 * Creates a brand-new, uniquely named database for this test run, applies the real migrations
 * with `prisma migrate deploy` (additive only), and drops exactly that database afterwards.
 * Existing databases — dev or otherwise — are never reset or touched.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const noop = async () => {}
  loadEnvFile()
  const baseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  if (!baseUrl) {
    project.provide('testDatabaseUrl', null)
    return noop
  }

  const server = new URL(baseUrl)
  const baseName = server.pathname.replace(/^\//, '') || 'app'
  const dbName = `${baseName}_test_${Date.now()}_${randomBytes(3).toString('hex')}`

  const client = adminClient(server)
  try {
    await client.connect()
  } catch (error) {
    // pg error messages name the host/user but never include the password.
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[db tests] cannot connect to ${server.host} (${reason}) — skipping DB tests\n`,
    )
    project.provide('testDatabaseUrl', null)
    return noop
  }

  try {
    await client.query(`CREATE DATABASE "${dbName}"`)
  } finally {
    await client.end()
  }

  const testUrl = new URL(server)
  testUrl.pathname = `/${dbName}`
  execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: 'pipe',
  })
  project.provide('testDatabaseUrl', testUrl.toString())

  return async () => {
    const cleanup = adminClient(server)
    await cleanup.connect()
    try {
      // Only ever drops the database created above in this same run.
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    } finally {
      await cleanup.end()
    }
  }
}
