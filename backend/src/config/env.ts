import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const ROOT_ENV_FILE = resolve(import.meta.dirname, '../../../.env')

/** Empty values in .env ("KEY=") are treated as "not set". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

/** Hosts where plain HTTP to the signer never leaves the machine. */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  )
}

const envSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    NETWORK_MODE: z.enum(['testnet', 'mainnet']).default('testnet'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    BACKEND_HOST: z.string().min(1).default('127.0.0.1'),
    BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * Reverse proxy addresses/CIDRs whose X-Forwarded-For is trusted (production: Caddy's IP).
     * Unset = trust nobody (direct connections). Never a wildcard: clients could spoof their IP
     * and dodge the per-IP login limit.
     */
    TRUST_PROXY: optional(
      z
        .string()
        .trim()
        .regex(/^[0-9a-fA-F:./]+(\s*,\s*[0-9a-fA-F:./]+)*$/, 'comma-separated IPs / CIDRs'),
    ),
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
    /** Lifetime of an ownership-verification challenge (docs/02 §2.4). */
    CHALLENGE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(15),

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

    // --- Recovery eligibility (Phase 8b) ---
    /** Minimum fiat value that must arrive after fees; at or below it an asset is NOT_ECONOMIC. */
    RECOVERY_MIN_NET_VALUE: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,8})?$/, 'must be a decimal amount, e.g. 10 or 12.50')
      .default('10'),
    /** Safety margin on top of the EIP-1559 fee estimate, in percent (docs/02 §2.6). */
    FEE_MARGIN_PERCENT: z.coerce.number().int().min(0).max(200).default(20),
    /** Balances older than this are STALE_BALANCE (daily scans + slack). */
    ELIGIBILITY_BALANCE_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(720).default(36),

    // --- Transactions (Phase 9) ---
    /** An approval stays valid this long; then the transaction must be previewed again. */
    APPROVAL_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
    /** Phase 11: blocks (incl. the inclusion block) before a transaction is CONFIRMED. */
    TX_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(3),
    /** How often CHECK_PENDING_TRANSACTIONS runs. */
    TX_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(600).default(30),
    /** Without a receipt for this long, a broadcast transaction is flagged STUCK. */
    TX_STUCK_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

    // --- Signer / key vault (Phase 7) ---
    /**
     * Plain http only to a loopback host: requests carry vault passphrases and (on reveal) keys,
     * and HMAC protects integrity, not confidentiality (ADR-019). Elsewhere use https.
     */
    SIGNER_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:4000'),
    /** Explicit, logged opt-out for a private container network until TLS is set up (Phase 14). */
    SIGNER_ALLOW_INSECURE_HTTP: z.enum(['true', 'false']).default('false'),

    /** Mainnet: the first transfer to each destination must be a test transfer worth at most this. */
    MAINNET_FIRST_TRANSFER_MAX_VALUE: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,8})?$/, 'must be a decimal amount')
      .default('25'),

    // --- Monitoring (Phase 13b) ---
    /** Bearer token for GET /metrics (Prometheus). Unset = /metrics answers 404. */
    METRICS_TOKEN: optional(z.string().min(32).max(256)),

    // --- Alerts (Phase 13b) ---
    /** Telegram bot for security alerts (vault, reveal, signing, broadcast, audit chain...). */
    TELEGRAM_BOT_TOKEN: optional(
      z.string().regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'not a bot token'),
    ),
    /** Chat / group / channel id (e.g. -1001234567890 or @channel). */
    TELEGRAM_CHAT_ID: optional(z.string().regex(/^(-?\d{5,}|@[A-Za-z0-9_]{5,})$/, 'not a chat id')),
    /** Shared with the signer. Without it, vault endpoints answer SIGNER_UNAVAILABLE. */
    SIGNER_HMAC_SECRET: optional(z.string().min(32)),

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
  .refine((env) => Boolean(env.TELEGRAM_BOT_TOKEN) === Boolean(env.TELEGRAM_CHAT_ID), {
    message: 'set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or neither',
    path: ['TELEGRAM_CHAT_ID'],
  })
  .refine(
    (env) =>
      env.SIGNER_ALLOW_INSECURE_HTTP === 'true' ||
      new URL(env.SIGNER_URL).protocol === 'https:' ||
      isLoopbackHost(new URL(env.SIGNER_URL).hostname),
    {
      message: 'plain http is only allowed to a loopback host (or set SIGNER_ALLOW_INSECURE_HTTP)',
      path: ['SIGNER_URL'],
    },
  )

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

/**
 * Refuses an unsafe production configuration (Phase 14, ADR-028). Returns problems as
 * sentences that name variables only — never their values.
 */
export function productionProblems(env: Env, raw: NodeJS.ProcessEnv): string[] {
  if (env.APP_ENV !== 'production') return []
  const problems: string[] = []
  const devValue = (value: string | undefined) => Boolean(value && /dev_only|changeme/i.test(value))
  if (devValue(env.DATABASE_URL)) problems.push('DATABASE_URL uses a development password')
  if (!new URL(env.REDIS_URL).password) problems.push('REDIS_URL must include a password')
  if (new URL(env.APP_ORIGIN).protocol !== 'https:') problems.push('APP_ORIGIN must be https')
  if (env.COOKIE_SECURE === 'false') problems.push('COOKIE_SECURE must not be false')
  if (!env.SIGNER_HMAC_SECRET) problems.push('SIGNER_HMAC_SECRET is required')
  // Behind the reverse proxy every client would otherwise share the proxy's IP (login limits, audit).
  if (!env.TRUST_PROXY) problems.push('TRUST_PROXY is required (the reverse proxy subnet)')
  if (env.SIGNER_ALLOW_INSECURE_HTTP === 'true') {
    problems.push(
      'SIGNER_ALLOW_INSECURE_HTTP must not be used (the signer shares the backend network namespace)',
    )
  }
  // Separation of duties (ADR-008): vault credentials belong to the signer only.
  for (const name of ['VAULT_DATABASE_URL', 'APP_DATABASE_URL_READONLY']) {
    if (raw[name]) problems.push(`${name} must not be in the backend environment`)
  }
  return problems
}
