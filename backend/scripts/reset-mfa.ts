/**
 * Server-side MFA reset — the ONLY way to reset a SUPER_ADMIN's authenticator (ADR-027).
 * Works for any user; for other roles an ADMIN can also use the Users page.
 *
 *   pnpm --filter backend user:reset-mfa --email a@b.c --reason "Identity verified by video call + ID"
 *
 * All sessions of the user end; MFA is set up again at the next login. Audited (MFA_RESET_CLI).
 */
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { createLogger } from '@da/shared'
import { loadEnvFile } from '../src/config/env'
import { createPrismaClient } from '../src/lib/prisma'
import { createAuditLogRepository } from '../src/repositories/audit-log.repository'
import { createSessionRepository } from '../src/repositories/session.repository'
import { createUserRepository, roleList } from '../src/repositories/user.repository'

const logger = createLogger({ name: 'reset-mfa' })

function fail(message: string): never {
  logger.error(message)
  process.exit(1)
}

const { values } = parseArgs({
  options: { email: { type: 'string' }, reason: { type: 'string' } },
})
const args = z
  .object({ email: z.email(), reason: z.string().trim().min(10).max(500) })
  .safeParse(values)
if (!args.success) {
  fail(
    'Usage: pnpm --filter backend user:reset-mfa --email <email> --reason "<how identity was verified (min 10 chars)>"',
  )
}

loadEnvFile()
const databaseUrl = process.env.DATABASE_URL ?? fail('DATABASE_URL is not set')
const db = createPrismaClient(databaseUrl)
try {
  const users = createUserRepository(db)
  const email = args.data.email.toLowerCase()
  const user = (await users.findByEmail(email)) ?? fail(`No user with email ${email}`)
  await users.resetMfa(user.id)
  const revokedSessions = await createSessionRepository(db).revokeAllForUser(user.id, new Date())
  await createAuditLogRepository(db).create({
    action: 'MFA_RESET_CLI',
    result: 'SUCCESS',
    resourceType: 'user',
    resourceId: user.id,
    metadata: {
      email,
      roles: roleList(user),
      reason: args.data.reason,
      revokedSessions,
      host: hostname(),
    },
  })
  logger.info({ email, revokedSessions }, 'MFA_RESET')
} finally {
  await db.$disconnect()
}
