import { describe, expect, it } from 'vitest'
import {
  analyzeActivity,
  daysBetween,
  type AnalyzerInput,
} from '../../src/domain/activity-analyzer'

const SCAN = new Date('2026-10-01T00:00:00Z')
const daysAgo = (n: number) => new Date(SCAN.getTime() - n * 86_400_000)

function input(
  overrides: Partial<Omit<AnalyzerInput, 'activity'>> & {
    activity?: Partial<AnalyzerInput['activity']>
  } = {},
): AnalyzerInput {
  const { activity, ...rest } = overrides
  return {
    scanDate: SCAN,
    thresholdDays: 730,
    nonce: 3,
    nativeBalance: 10n ** 15n,
    tokenBalances: [],
    activity: {
      firstActivityAt: daysAgo(2000),
      lastIncomingAt: daysAgo(1200),
      lastOutgoingAt: daysAgo(1148),
      outgoingTxCount: 3,
      truncated: false,
      ...activity,
    },
    ...rest,
  }
}

describe('daysBetween', () => {
  it('matches the SA 4.3 example (2023-08-10 → 2026-10-01 = 1148 days)', () => {
    expect(daysBetween(new Date('2023-08-10T00:00:00Z'), SCAN)).toBe(1148)
  })

  it('never goes negative (clock skew)', () => {
    expect(daysBetween(new Date(SCAN.getTime() + 5000), SCAN)).toBe(0)
  })
})

describe('analyzeActivity — threshold boundary', () => {
  it.each([
    [729, 'ACTIVE'],
    [730, 'INACTIVE'], // exactly on the threshold counts as inactive (SA: >=)
    [731, 'INACTIVE'],
  ] as const)('last outgoing %i days ago → %s', (days, status) => {
    const result = analyzeActivity(input({ activity: { lastOutgoingAt: daysAgo(days) } }))
    expect(result.activityStatus).toBe(status)
    expect(result.inactiveDays).toBe(days)
  })
})

describe('analyzeActivity — outgoing basis', () => {
  it('ignores recent incoming transfers (spam/airdrops do not revive a wallet)', () => {
    const result = analyzeActivity(
      input({ activity: { lastIncomingAt: daysAgo(2), lastOutgoingAt: daysAgo(1500) } }),
    )
    expect(result).toMatchObject({ activityStatus: 'INACTIVE', inactiveDays: 1500 })
    expect(result.lastActivityAt).toEqual(daysAgo(2)) // still reported as the latest activity
  })

  it('measures a never-sent address from its first activity', () => {
    const result = analyzeActivity(
      input({
        nonce: 0,
        activity: {
          firstActivityAt: daysAgo(1000),
          lastIncomingAt: daysAgo(5),
          lastOutgoingAt: null,
          outgoingTxCount: 0,
        },
      }),
    )
    expect(result).toMatchObject({
      activityStatus: 'INACTIVE',
      inactiveDays: 1000,
      inactiveSince: daysAgo(1000),
    })
  })

  it('treats an address with no history at all as inactive with unknown duration', () => {
    const result = analyzeActivity(
      input({
        nonce: 0,
        nativeBalance: 0n,
        activity: {
          firstActivityAt: null,
          lastIncomingAt: null,
          lastOutgoingAt: null,
          outgoingTxCount: 0,
        },
      }),
    )
    expect(result).toMatchObject({
      activityStatus: 'INACTIVE',
      balanceStatus: 'EMPTY',
      inactiveDays: null,
      lastActivityAt: null,
      reviewReasons: [],
    })
  })
})

describe('analyzeActivity — balances', () => {
  it.each([
    ['nothing', 0n, [], 'EMPTY'],
    ['1 wei native', 1n, [], 'HAS_BALANCE'],
    ['zero token balances', 0n, [0n, 0n], 'EMPTY'],
    ['token-only balance', 0n, [0n, 5n], 'HAS_BALANCE'],
  ] as const)('%s → %s', (_label, native, tokens, status) => {
    expect(
      analyzeActivity(input({ nativeBalance: native, tokenBalances: tokens })).balanceStatus,
    ).toBe(status)
  })
})

describe('analyzeActivity — review flags', () => {
  it('flags a nonce / explorer mismatch', () => {
    expect(analyzeActivity(input({ nonce: 4 })).reviewReasons).toEqual(['NONCE_MISMATCH'])
  })

  it('reports truncation instead of a (meaningless) nonce mismatch', () => {
    const result = analyzeActivity(
      input({ nonce: 25_000, activity: { outgoingTxCount: 10_000, truncated: true } }),
    )
    expect(result.reviewReasons).toEqual(['HISTORY_TRUNCATED'])
  })

  it('flags funds without any history', () => {
    const result = analyzeActivity(
      input({
        nonce: 0,
        activity: {
          firstActivityAt: null,
          lastIncomingAt: null,
          lastOutgoingAt: null,
          outgoingTxCount: 0,
        },
      }),
    )
    expect(result.reviewReasons).toEqual(['BALANCE_WITHOUT_HISTORY'])
  })

  it('has no flags when sources agree', () => {
    expect(analyzeActivity(input()).reviewReasons).toEqual([])
  })
})
