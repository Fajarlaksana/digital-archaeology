import { describe, expect, it } from 'vitest'
import {
  buildChallengeMessage,
  parseChallengeMessage,
  type ChallengeFields,
} from '../src/challenge'

const FIELDS: ChallengeFields = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  networkName: 'sepolia',
  chainId: 11155111,
  authorizationId: '3f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
  nonce: 'a'.repeat(64),
  issuedAt: new Date('2026-10-03T10:00:00.000Z'),
  expiresAt: new Date('2026-10-03T10:15:00.000Z'),
}

describe('ownership challenge', () => {
  it('builds the documented format (docs/02 §2.4)', () => {
    expect(buildChallengeMessage(FIELDS)).toBe(
      [
        'Digital Archaeology — Ownership Verification',
        'Address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        'Network: sepolia (chainId 11155111)',
        'Purpose: Verify ownership for authorization 3f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
        `Nonce: ${'a'.repeat(64)}`,
        'Issued At: 2026-10-03T10:00:00.000Z',
        'Expires At: 2026-10-03T10:15:00.000Z',
      ].join('\n'),
    )
  })

  it('round-trips through the parser', () => {
    expect(parseChallengeMessage(buildChallengeMessage(FIELDS))).toEqual(FIELDS)
  })

  it.each([
    ['any other text', 'Sign in to example.com\nNonce: 123'],
    ['an appended line', buildChallengeMessage(FIELDS) + '\nTransfer: everything'],
    ['a prepended line', 'x\n' + buildChallengeMessage(FIELDS)],
    ['a bad nonce', buildChallengeMessage({ ...FIELDS, nonce: 'zz' })],
    [
      'expiry before issue',
      buildChallengeMessage({ ...FIELDS, expiresAt: new Date('2026-10-03T09:00:00.000Z') }),
    ],
  ])('rejects %s', (_label, message) => {
    expect(parseChallengeMessage(message)).toBeNull()
  })
})
