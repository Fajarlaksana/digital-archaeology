import { describe, expect, it } from 'vitest'
import { REDACTED } from '../src/logger'
import { redactSensitive } from '../src/redact'

const SECRET =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('redactSensitive', () => {
  it('redacts sensitive keys at any depth', () => {
    const input = { a: { b: { c: { d: { e: { f: { mnemonic: SECRET } } } } } } }
    expect(JSON.stringify(redactSensitive(input))).not.toContain(SECRET)
  })

  it('is case-insensitive on key names', () => {
    const output = redactSensitive({ PrivateKey: SECRET, PASSWORD: SECRET }) as Record<
      string,
      unknown
    >
    expect(output).toEqual({ PrivateKey: REDACTED, PASSWORD: REDACTED })
  })

  it('redacts inside arrays', () => {
    const output = redactSensitive({ items: [{ seed: SECRET }, { ok: 1 }] })
    expect(output).toEqual({ items: [{ seed: REDACTED }, { ok: 1 }] })
  })

  it('keeps safe values and does not mutate the input', () => {
    const input = {
      address: '0xabc',
      amount: 10n,
      at: new Date('2026-10-02T00:00:00Z'),
      password: 'x',
    }
    const output = redactSensitive(input)
    expect(output).toEqual({
      address: '0xabc',
      amount: '10',
      at: '2026-10-02T00:00:00.000Z',
      password: REDACTED,
    })
    expect(input.password).toBe('x')
  })

  it('passes primitives through', () => {
    expect(redactSensitive('text')).toBe('text')
    expect(redactSensitive(null)).toBeNull()
    expect(redactSensitive(5)).toBe(5)
  })
})
