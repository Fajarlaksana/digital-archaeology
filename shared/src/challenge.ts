/**
 * Signed challenges (docs/02 §2.4). Built by the backend and signed by the key holder.
 *
 * - Ownership (Phase 7c): proves control of an inventory address. For vault signing it is
 *   re-validated by the signer, which refuses to sign anything else (ADR-018).
 * - Destination (Phase 8a): proves control of a destination wallet before it can be approved.
 *   It has its own title, so the signer's ownership parser never accepts it.
 */
export const CHALLENGE_TITLE = 'Digital Archaeology — Ownership Verification'
export const DESTINATION_CHALLENGE_TITLE = 'Digital Archaeology — Destination Verification'

interface BaseChallengeFields {
  address: string
  networkName: string
  chainId: number | null
  /** 64 hex characters (32 random bytes). */
  nonce: string
  issuedAt: Date
  expiresAt: Date
}

export interface ChallengeFields extends BaseChallengeFields {
  /** Authorization record this proof belongs to. */
  authorizationId: string
}

export interface DestinationChallengeFields extends BaseChallengeFields {
  /** Destination (whitelist entry) this proof belongs to. */
  destinationId: string
}

const OWNERSHIP_PURPOSE = 'Verify ownership for authorization'
const DESTINATION_PURPOSE = 'Verify control of destination'

function build(title: string, purpose: string, fields: BaseChallengeFields): string {
  return [
    title,
    `Address: ${fields.address}`,
    `Network: ${fields.networkName} (chainId ${fields.chainId ?? 'n/a'})`,
    `Purpose: ${purpose}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expires At: ${fields.expiresAt.toISOString()}`,
  ].join('\n')
}

function pattern(title: string, purpose: string): RegExp {
  return new RegExp(
    [
      `^${title}`,
      'Address: (0x[0-9a-fA-F]{40})',
      'Network: ([a-z0-9-]{1,40}) \\(chainId (\\d{1,12}|n/a)\\)',
      `Purpose: ${purpose} ([0-9a-f-]{36})`,
      'Nonce: ([0-9a-f]{64})',
      'Issued At: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)',
      'Expires At: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)$',
    ].join('\\n'),
  )
}

const OWNERSHIP_PATTERN = pattern(CHALLENGE_TITLE, OWNERSHIP_PURPOSE)
const DESTINATION_PATTERN = pattern(DESTINATION_CHALLENGE_TITLE, DESTINATION_PURPOSE)

/** Returns the fields plus the subject id, or null unless `message` matches exactly. */
function parse(regex: RegExp, message: string): (BaseChallengeFields & { id: string }) | null {
  const m = regex.exec(message)
  if (!m) return null
  const [, address, networkName, chainId, id, nonce, issuedAt, expiresAt] = m
  const issued = new Date(issuedAt!)
  const expires = new Date(expiresAt!)
  if (Number.isNaN(issued.getTime()) || Number.isNaN(expires.getTime()) || expires <= issued)
    return null
  return {
    address: address!,
    networkName: networkName!,
    chainId: chainId === 'n/a' ? null : Number(chainId),
    id: id!,
    nonce: nonce!,
    issuedAt: issued,
    expiresAt: expires,
  }
}

export function buildChallengeMessage(fields: ChallengeFields): string {
  return build(CHALLENGE_TITLE, `${OWNERSHIP_PURPOSE} ${fields.authorizationId}`, fields)
}

/** Parses an ownership challenge; returns null unless it is exactly a well-formed one. */
export function parseChallengeMessage(message: string): ChallengeFields | null {
  const parsed = parse(OWNERSHIP_PATTERN, message)
  if (!parsed) return null
  const { id, ...rest } = parsed
  return { ...rest, authorizationId: id }
}

export function buildDestinationChallengeMessage(fields: DestinationChallengeFields): string {
  return build(
    DESTINATION_CHALLENGE_TITLE,
    `${DESTINATION_PURPOSE} ${fields.destinationId}`,
    fields,
  )
}

/** Parses a destination challenge; returns null unless it is exactly a well-formed one. */
export function parseDestinationChallengeMessage(
  message: string,
): DestinationChallengeFields | null {
  const parsed = parse(DESTINATION_PATTERN, message)
  if (!parsed) return null
  const { id, ...rest } = parsed
  return { ...rest, destinationId: id }
}
