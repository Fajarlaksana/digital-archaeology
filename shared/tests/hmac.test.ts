import { describe, expect, it } from 'vitest'
import {
  HMAC_SIGNATURE_HEADER,
  HMAC_TIMESTAMP_HEADER,
  signRequest,
  verifyRequest,
} from '../src/hmac'

const SECRET = 'x'.repeat(40)
const NOW = 1_790_000_000_000
const req = { method: 'POST', path: '/vault/unlock', body: '{"a":1}', timestamp: NOW }

function verify(overrides: Partial<Parameters<typeof verifyRequest>[1]> = {}, secret = SECRET) {
  const headers = signRequest(SECRET, req)
  return verifyRequest(secret, {
    method: req.method,
    path: req.path,
    body: req.body,
    timestamp: headers[HMAC_TIMESTAMP_HEADER],
    signature: headers[HMAC_SIGNATURE_HEADER],
    now: NOW,
    ...overrides,
  })
}

describe('HMAC request signing', () => {
  it('accepts an untouched request', () => {
    expect(verify().ok).toBe(true)
  })

  it.each([
    ['body', { body: '{"a":2}' }],
    ['path', { path: '/vault/reveal' }],
    ['method', { method: 'GET' }],
  ])('rejects a tampered %s', (_label, overrides) => {
    expect(verify(overrides)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('rejects a different secret', () => {
    expect(verify({}, 'y'.repeat(40))).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
  })

  it('rejects stale and future timestamps outside ±60 s', () => {
    expect(verify({ now: NOW + 60_001 })).toEqual({ ok: false, reason: 'EXPIRED' })
    expect(verify({ now: NOW - 60_001 })).toEqual({ ok: false, reason: 'EXPIRED' })
    expect(verify({ now: NOW + 59_000 }).ok).toBe(true)
  })

  it('rejects missing or malformed headers', () => {
    expect(verify({ signature: undefined })).toEqual({ ok: false, reason: 'MISSING' })
    expect(verify({ signature: 'nothex' })).toEqual({ ok: false, reason: 'MALFORMED' })
    expect(verify({ timestamp: '12abc' })).toEqual({ ok: false, reason: 'MALFORMED' })
  })
})
