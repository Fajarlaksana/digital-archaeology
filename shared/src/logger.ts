import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino'

/**
 * Field names whose values must never reach a log line (CLAUDE.md rule 9).
 * Matching is by exact key name, at any depth up to MAX_REDACT_DEPTH.
 */
export const SENSITIVE_KEYS = [
  'privateKey',
  'private_key',
  'seed',
  'seedPhrase',
  'seed_phrase',
  'mnemonic',
  'passphrase',
  'recoveryPassphrase',
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'signature',
  'signedTx',
  'rawTx',
] as const

const MAX_REDACT_DEPTH = 4
export const REDACTED = '[REDACTED]'

function buildRedactPaths(): string[] {
  const paths: string[] = []
  for (const key of SENSITIVE_KEYS) {
    for (let depth = 0; depth < MAX_REDACT_DEPTH; depth++) {
      paths.push([...Array<string>(depth).fill('*'), key].join('.'))
    }
  }
  // Header names that are not valid identifiers need bracket notation.
  paths.push('req.headers["x-api-key"]', 'res.headers["set-cookie"]')
  return paths
}

export const REDACT_PATHS = buildRedactPaths()

export interface CreateLoggerOptions {
  name: string
  level?: LoggerOptions['level']
  destination?: DestinationStream
}

export function createLogger({ name, level = 'info', destination }: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
  }
  return destination ? pino(options, destination) : pino(options)
}

export type { Logger }
