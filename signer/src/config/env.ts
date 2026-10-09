import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { HMAC_MIN_SECRET_LENGTH } from '@da/shared'

const ROOT_ENV_FILE = resolve(import.meta.dirname, '../../../.env')
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

const envSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    SIGNER_HOST: z.string().min(1).default('127.0.0.1'),
    SIGNER_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /** Must be set explicitly to bind outside loopback (e.g. a private container network). */
    SIGNER_ALLOW_NON_LOOPBACK: z.enum(['true', 'false']).default('false'),
    VAULT_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    SIGNER_HMAC_SECRET: z.string().min(HMAC_MIN_SECRET_LENGTH),
    VAULT_UNLOCK_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    KEY_REVEAL_ENABLED: z.enum(['true', 'false']).default('true'),
    /**
     * Read-only login (da_signer_ro) to the APPLICATION database, used to verify approvals
     * before signing transactions (ADR-023). Without it, transaction signing is disabled.
     */
    APP_DATABASE_URL_READONLY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    ),
  })
  .refine((env) => LOOPBACK.has(env.SIGNER_HOST) || env.SIGNER_ALLOW_NON_LOOPBACK === 'true', {
    message: 'must be a loopback address unless SIGNER_ALLOW_NON_LOOPBACK=true',
    path: ['SIGNER_HOST'],
  })

export type SignerEnv = z.infer<typeof envSchema>

export function loadEnvFile(path: string = ROOT_ENV_FILE): void {
  if (existsSync(path)) process.loadEnvFile(path)
}

/** Lists only NAMES of invalid variables — never values (the HMAC secret, DB password…). */
export function parseEnv(source: NodeJS.ProcessEnv): SignerEnv {
  const result = envSchema.safeParse(source)
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid or missing environment variables: ${names.join(', ')}`)
  }
  return result.data
}

/**
 * Refuses an unsafe production configuration (Phase 14, ADR-028). Problems name variables only.
 */
export function productionProblems(env: SignerEnv, raw: NodeJS.ProcessEnv): string[] {
  if (env.APP_ENV !== 'production') return []
  const problems: string[] = []
  const devValue = (value: string | undefined) => Boolean(value && /dev_only|changeme/i.test(value))
  if (devValue(env.VAULT_DATABASE_URL))
    problems.push('VAULT_DATABASE_URL uses a development password')
  if (env.SIGNER_ALLOW_NON_LOOPBACK === 'true') {
    problems.push(
      'SIGNER_ALLOW_NON_LOOPBACK must not be used (share the backend network namespace instead)',
    )
  }
  if (!env.APP_DATABASE_URL_READONLY) {
    problems.push('APP_DATABASE_URL_READONLY is required (transaction signing)')
  } else {
    const url = new URL(env.APP_DATABASE_URL_READONLY)
    if (decodeURIComponent(url.username) !== 'da_signer_ro') {
      problems.push('APP_DATABASE_URL_READONLY must use the read-only login da_signer_ro')
    }
    if (devValue(env.APP_DATABASE_URL_READONLY)) {
      problems.push('APP_DATABASE_URL_READONLY uses a development password')
    }
  }
  // The signer never needs the application owner login or the backend's secrets.
  for (const name of ['DATABASE_URL', 'MFA_ENCRYPTION_KEY', 'REDIS_URL']) {
    if (raw[name]) problems.push(`${name} must not be in the signer environment`)
  }
  return problems
}
