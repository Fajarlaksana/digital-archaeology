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
