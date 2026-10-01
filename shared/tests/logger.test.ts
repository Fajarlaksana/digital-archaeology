import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger, REDACTED, SENSITIVE_KEYS } from '../src/logger'

function captureLogger() {
  const lines: string[] = []
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString())
      callback()
    },
  })
  const logger = createLogger({ name: 'test', level: 'trace', destination })
  return { logger, output: () => lines.join('') }
}

const SECRET = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'

describe('logger redaction', () => {
  it.each(SENSITIVE_KEYS)('redacts top-level "%s"', (key) => {
    const { logger, output } = captureLogger()
    logger.info({ [key]: SECRET }, 'event')
    expect(output()).not.toContain(SECRET)
    expect(JSON.parse(output())[key]).toBe(REDACTED)
  })

  it.each([
    ['nested 1 level', { body: { privateKey: SECRET } }],
    ['nested 2 levels', { req: { body: { mnemonic: SECRET } } }],
    ['nested 3 levels', { a: { b: { c: { passphrase: SECRET } } } }],
    [
      'request headers',
      { req: { headers: { authorization: `Bearer ${SECRET}`, cookie: SECRET } } },
    ],
    ['set-cookie header', { res: { headers: { 'set-cookie': SECRET } } }],
  ])('redacts %s', (_label, payload) => {
    const { logger, output } = captureLogger()
    logger.info(payload, 'event')
    expect(output()).not.toContain(SECRET)
    expect(output()).toContain(REDACTED)
  })

  it('keeps non-sensitive fields intact', () => {
    const { logger, output } = captureLogger()
    logger.info({ scanId: 'scan-1', network: 'sepolia' }, 'SCAN_STARTED')
    const line = JSON.parse(output())
    expect(line).toMatchObject({ scanId: 'scan-1', network: 'sepolia', msg: 'SCAN_STARTED' })
  })
})
