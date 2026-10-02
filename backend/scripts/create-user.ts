/**
 * Server-side user creation — the ONLY way to create a SUPER_ADMIN (ADR-003).
 *
 *   pnpm --filter backend user:create --email a@b.c --name "Alice" --role SUPER_ADMIN
 *
 * The password is read from the terminal without echo (or one line from stdin when piped).
 * Users with SUPER_ADMIN / ADMIN / REVIEWER set up MFA on their first login.
 */
import { hostname } from 'node:os'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { createLogger } from '@da/shared'
import { hashPassword, passwordPolicyViolation } from '../src/auth/password'
import { requiresMfa } from '../src/auth/permissions'
import { loadEnvFile } from '../src/config/env'
import { Role } from '../src/generated/prisma/enums'
import { createPrismaClient } from '../src/lib/prisma'
import { createAuditLogRepository } from '../src/repositories/audit-log.repository'
import { createUserRepository, roleList } from '../src/repositories/user.repository'

const logger = createLogger({ name: 'create-user' })

function fail(message: string): never {
  logger.error(message)
  process.exit(1)
}

let pipedLines: AsyncIterator<string> | undefined

/** Reads one line from the terminal without echoing it (or the next line of piped stdin). */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stderr.write(prompt)
    if (!stdin.isTTY) {
      // One shared reader, so several lines arriving in a single chunk are not lost.
      pipedLines ??= createInterface({ input: stdin, crlfDelay: Infinity })[Symbol.asyncIterator]()
      void pipedLines.next().then((line) => {
        process.stderr.write('\n')
        resolve(line.done ? '' : line.value)
      })
      return
    }
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (key: string) => {
      for (const char of key) {
        if (char === '\u0003') {
          process.stderr.write('\n')
          process.exit(130) // Ctrl+C
        } else if (char === '\r' || char === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stderr.write('\n')
          resolve(value)
          return
        } else if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
        } else {
          value += char
        }
      }
    }
    stdin.on('data', onData)
  })
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', multiple: true },
  },
})

const args = z
  .object({
    email: z.email(),
    name: z.string().trim().min(1).max(120),
    role: z.array(z.enum(Role)).min(1),
  })
  .safeParse(values)
if (!args.success) {
  fail(
    'Usage: pnpm --filter backend user:create --email <email> --name <name> --role <ROLE> [--role <ROLE>]\n' +
      `Roles: ${Object.values(Role).join(', ')}`,
  )
}

loadEnvFile()
const databaseUrl = process.env.DATABASE_URL ?? fail('DATABASE_URL is not set')

const password = await readHidden('Password: ')
const violation = passwordPolicyViolation(password)
if (violation) fail(violation)
if ((await readHidden('Repeat password: ')) !== password) fail('Passwords do not match')

const db = createPrismaClient(databaseUrl)
try {
  const users = createUserRepository(db)
  const email = args.data.email.toLowerCase()
  if (await users.findByEmail(email)) fail(`A user with email ${email} already exists`)

  const created = await users.create({
    email,
    name: args.data.name,
    passwordHash: await hashPassword(password),
    roles: [...new Set(args.data.role)],
  })
  await createAuditLogRepository(db).create({
    action: 'USER_CREATED_CLI',
    result: 'SUCCESS',
    resourceType: 'user',
    resourceId: created.id,
    metadata: { email, roles: roleList(created), host: hostname() },
  })
  logger.info(
    { email, roles: roleList(created), mfaRequiredAtFirstLogin: requiresMfa(roleList(created)) },
    'USER_CREATED',
  )
} finally {
  await db.$disconnect()
}
