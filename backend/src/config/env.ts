import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const ROOT_ENV_FILE = resolve(import.meta.dirname, '../../../.env')

/** Empty values in .env ("KEY=") are treated as "not set". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NETWORK_MODE: z.enum(['testnet', 'mainnet']).default('testnet'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BACKEND_HOST: z.string().min(1).default('127.0.0.1'),
  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  SEPOLIA_RPC_URL: optional(z.url({ protocol: /^https?$/ })),
})

export type Env = z.infer<typeof envSchema>

/** Loads the repository-root .env into process.env, if the file exists. */
export function loadEnvFile(path: string = ROOT_ENV_FILE): void {
  if (existsSync(path)) process.loadEnvFile(path)
}

/**
 * Validates environment variables. Throws listing only the variable NAMES that are
 * missing or invalid — never their values, which may be secrets.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source)
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`Invalid or missing environment variables: ${names.join(', ')}`)
  }
  return result.data
}
