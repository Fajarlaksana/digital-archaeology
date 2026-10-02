/**
 * Decides activity / balance status for one address from raw chain data (SA 4.3, ADR-015).
 * Pure: no I/O, no clock — the scan date is an input.
 *
 * Inactivity basis = OUTGOING transactions: only the key holder can send, so incoming spam or
 * airdrops never make a dormant wallet look "active". An address that never sent anything is
 * measured from its first known activity (the owner has never acted since it was funded).
 */

const DAY_MS = 86_400_000

export type ReviewReason =
  /** RPC nonce differs from the explorer's outgoing count — one of the sources is wrong/incomplete. */
  | 'NONCE_MISMATCH'
  /** Explorer history hit its page limit; counts are lower bounds. */
  | 'HISTORY_TRUNCATED'
  /** Holds funds but no transaction was found (e.g. validator withdrawals, genesis allocation). */
  | 'BALANCE_WITHOUT_HISTORY'

export interface AnalyzerInput {
  scanDate: Date
  thresholdDays: number
  nonce: number
  nativeBalance: bigint
  tokenBalances: readonly bigint[]
  activity: {
    firstActivityAt: Date | null
    lastIncomingAt: Date | null
    lastOutgoingAt: Date | null
    outgoingTxCount: number
    truncated: boolean
  }
}

export interface AnalyzerResult {
  activityStatus: 'ACTIVE' | 'INACTIVE'
  balanceStatus: 'EMPTY' | 'HAS_BALANCE'
  /** Most recent activity of any kind (informational). */
  lastActivityAt: Date | null
  /** Days since the inactivity reference point; null when the address has no history at all. */
  inactiveDays: number | null
  /** The moment inactivity is measured from. */
  inactiveSince: Date | null
  reviewReasons: ReviewReason[]
}

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS))
}

export function analyzeActivity(input: AnalyzerInput): AnalyzerResult {
  const { activity } = input
  const hasBalance = input.nativeBalance > 0n || input.tokenBalances.some((b) => b > 0n)

  const candidates = [activity.lastIncomingAt, activity.lastOutgoingAt].filter(
    (d): d is Date => d !== null,
  )
  const lastActivityAt = candidates.length
    ? new Date(Math.max(...candidates.map((d) => d.getTime())))
    : null

  const inactiveSince = activity.lastOutgoingAt ?? activity.firstActivityAt
  const inactiveDays = inactiveSince ? daysBetween(inactiveSince, input.scanDate) : null

  const reviewReasons: ReviewReason[] = []
  if (activity.truncated) reviewReasons.push('HISTORY_TRUNCATED')
  else if (input.nonce !== activity.outgoingTxCount) reviewReasons.push('NONCE_MISMATCH')
  if (hasBalance && inactiveSince === null) reviewReasons.push('BALANCE_WITHOUT_HISTORY')

  return {
    // No history at all = never used by its owner = inactive.
    activityStatus:
      inactiveDays === null || inactiveDays >= input.thresholdDays ? 'INACTIVE' : 'ACTIVE',
    balanceStatus: hasBalance ? 'HAS_BALANCE' : 'EMPTY',
    lastActivityAt,
    inactiveDays,
    inactiveSince,
    reviewReasons,
  }
}
