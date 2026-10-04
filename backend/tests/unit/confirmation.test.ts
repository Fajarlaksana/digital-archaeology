import { describe, expect, it } from 'vitest'
import { evaluateConfirmation } from '../../src/domain/confirmation'

const broadcastAt = new Date('2026-10-05T10:00:00Z')
const base = {
  current: 'BROADCASTED' as const,
  receipt: null,
  currentBlock: 1000n,
  required: 3,
  latestNonce: 7,
  txNonce: 7,
  broadcastAt,
  now: new Date('2026-10-05T10:01:00Z'),
  stuckAfterMs: 30 * 60_000,
}
const receipt = (blockNumber: bigint, status: 'success' | 'reverted' = 'success') => ({
  status,
  blockNumber,
  gasUsed: 21_000n,
  effectiveGasPrice: 12n * 10n ** 9n,
})

describe('evaluateConfirmation', () => {
  it('stays BROADCASTED while waiting in the mempool', () => {
    expect(evaluateConfirmation(base)).toEqual({
      status: 'BROADCASTED',
      confirmations: 0,
      failureReason: null,
      stuck: false,
    })
  })

  it('flags STUCK after the threshold but never fails it on time alone', () => {
    const late = evaluateConfirmation({ ...base, now: new Date('2026-10-05T10:30:00Z') })
    expect(late).toMatchObject({ status: 'BROADCASTED', stuck: true })
  })

  it('PENDING with fewer confirmations than required, CONFIRMED at the threshold', () => {
    expect(evaluateConfirmation({ ...base, receipt: receipt(999n) })).toMatchObject({
      status: 'PENDING',
      confirmations: 2,
    })
    expect(evaluateConfirmation({ ...base, receipt: receipt(998n) })).toMatchObject({
      status: 'CONFIRMED',
      confirmations: 3,
    })
    expect(
      evaluateConfirmation({ ...base, current: 'PENDING', receipt: receipt(1000n) }),
    ).toMatchObject({
      status: 'PENDING',
      confirmations: 1,
    })
  })

  it('FAILED when the transaction reverted, at any depth', () => {
    expect(evaluateConfirmation({ ...base, receipt: receipt(1000n, 'reverted') })).toEqual({
      status: 'FAILED',
      confirmations: 1,
      failureReason: 'REVERTED',
      stuck: false,
    })
  })

  it('FAILED when another transaction used the nonce (replaced or dropped)', () => {
    expect(evaluateConfirmation({ ...base, latestNonce: 8 })).toMatchObject({
      status: 'FAILED',
      failureReason: 'REPLACED_OR_DROPPED',
    })
  })

  it('a receipt from a block the RPC has not caught up with counts as 0 confirmations', () => {
    expect(evaluateConfirmation({ ...base, receipt: receipt(1001n) })).toMatchObject({
      status: 'PENDING',
      confirmations: 0,
    })
  })
})
