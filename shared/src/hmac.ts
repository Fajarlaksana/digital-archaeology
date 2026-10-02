import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Request signing between backend and signer (ADR-008). Both sides share SIGNER_HMAC_SECRET.
 * The signature covers timestamp, method, path(+query) and a SHA-256 of the exact body bytes,
 * so a captured request cannot be altered, and replays are bounded by the time window
 * (the signer additionally remembers recent signatures).
 */
export const HMAC_TIMESTAMP_HEADER = 'x-da-timestamp'
export const HMAC_SIGNATURE_HEADER = 'x-da-signature'
export const HMAC_MAX_SKEW_MS = 60_000
export const HMAC_MIN_SECRET_LENGTH = 32

export interface SignableRequest {
  method: string
  /** Path including the query string, e.g. "/vault/status". */
  path: string
  /** Exact body sent on the wire ("" when none). */
  body: string
  timestamp: number
}

function canonical(req: SignableRequest): string {
  const bodyHash = createHash('sha256').update(req.body, 'utf8').digest('hex')
  return `${req.timestamp}\n${req.method.toUpperCase()}\n${req.path}\n${bodyHash}`
}

export function signRequest(secret: string, req: SignableRequest): Record<string, string> {
  const signature = createHmac('sha256', secret).update(canonical(req)).digest('hex')
  return { [HMAC_TIMESTAMP_HEADER]: String(req.timestamp), [HMAC_SIGNATURE_HEADER]: signature }
}

export type HmacCheck =
  | { ok: true; signature: string }
  | { ok: false; reason: 'MISSING' | 'MALFORMED' | 'EXPIRED' | 'BAD_SIGNATURE' }

export function verifyRequest(
  secret: string,
  req: Omit<SignableRequest, 'timestamp'> & {
    timestamp: string | undefined
    signature: string | undefined
    now: number
  },
): HmacCheck {
  if (!req.timestamp || !req.signature) return { ok: false, reason: 'MISSING' }
  if (!/^\d{1,16}$/.test(req.timestamp) || !/^[0-9a-f]{64}$/.test(req.signature)) {
    return { ok: false, reason: 'MALFORMED' }
  }
  const timestamp = Number(req.timestamp)
  if (Math.abs(req.now - timestamp) > HMAC_MAX_SKEW_MS) return { ok: false, reason: 'EXPIRED' }

  const expected = createHmac('sha256', secret)
    .update(canonical({ method: req.method, path: req.path, body: req.body, timestamp }))
    .digest()
  const given = Buffer.from(req.signature, 'hex')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }
  return { ok: true, signature: req.signature }
}
