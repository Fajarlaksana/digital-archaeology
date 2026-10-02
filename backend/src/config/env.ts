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

  // --- Scanner (Phase 5) ---
  /** Etherscan API v2 key (one key covers all supported EVM chains). Scans refuse to start without it. */
  EXPLORER_API_KEY: optional(z.string().min(10).max(100)),
  EXPLORER_API_URL: z.url({ protocol: /^https$/ }).default('https://api.etherscan.io/v2/api'),
  /** Etherscan free tier allows 5 calls/second; stay below it. */
  EXPLORER_RATE_LIMIT_PER_SECOND: z.coerce.number().min(0.5).max(50).default(4),
  INACTIVITY_THRESHOLD_DAYS: z.coerce.number().int().min(1).max(36_500).default(730),

  // --- Valuation & scheduler (Phase 6) ---
  FIAT_CURRENCY: z.enum(['USD', 'IDR']).default('USD'),
  PRICE_API_URL: z.url({ protocol: /^https$/ }).default('https://api.coingecko.com/api/v3'),
  /** Optional CoinGecko key (demo or pro). Sent as a header, never in the URL. */
  PRICE_API_KEY: optional(z.string().min(8).max(100)),
  PRICE_UPDATE_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /** Cron for automatic scans of every active network; "off" disables. Default: daily 02:00. */
  SCAN_SCHEDULE_CRON: z
    .string()
    .trim()
    .regex(/^(off|(\S+\s+){4}\S+)$/, 'must be a 5-field cron expression or "off"')
    .default('0 2 * * *'),
  SCHEDULER_TIMEZONE: z.string().min(1).default('Asia/Jakarta'),

  // --- Auth (Phase 3) ---
  /** Origin of the web UI. State-changing requests from any other Origin are rejected (CSRF). */
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:5173'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(480).default(30),
  /** Defaults to true in production. Must be true whenever the app is served over HTTPS. */
  COOKIE_SECURE: optional(z.enum(['true', 'false'])),
  /** 32 random bytes, base64. Encrypts TOTP secrets at rest (AES-256-GCM). */
  MFA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((value) => Buffer.from(value, 'base64').length === 32, 'must decode to 32 bytes'),
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
