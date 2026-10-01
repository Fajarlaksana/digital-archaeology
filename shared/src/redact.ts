import { REDACTED, SENSITIVE_KEYS } from './logger'

const SENSITIVE = new Set<string>(SENSITIVE_KEYS.map((key) => key.toLowerCase()))
const MAX_DEPTH = 10

/**
 * Returns a deep copy of `value` with every sensitive key (any depth, case-insensitive)
 * replaced by "[REDACTED]". Use before persisting anything user-supplied, e.g. audit metadata.
 * Unlike the logger's path-based redaction, this walks the whole structure.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1))
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()

  const result: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    result[key] = SENSITIVE.has(key.toLowerCase()) ? REDACTED : redactSensitive(inner, depth + 1)
  }
  return result
}
