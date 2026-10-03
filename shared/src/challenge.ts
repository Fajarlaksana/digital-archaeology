/**
 * Ownership-verification challenge (docs/02 §2.4). Built by the backend, signed by the owner
 * (vault or wallet), and — for vault signing — re-validated by the signer, which refuses to sign
 * anything that is not exactly such a challenge (no arbitrary messages, ADR-018).
 */
export const CHALLENGE_TITLE = 'Digital Archaeology — Ownership Verification'

export interface ChallengeFields {
  address: string
  networkName: string
  chainId: number | null
  /** Authorization record this proof belongs to. */
  authorizationId: string
  /** 64 hex characters (32 random bytes). */
  nonce: string
  issuedAt: Date
  expiresAt: Date
}

export function buildChallengeMessage(fields: ChallengeFields): string {
  return [
    CHALLENGE_TITLE,
    `Address: ${fields.address}`,
    `Network: ${fields.networkName} (chainId ${fields.chainId ?? 'n/a'})`,
    `Purpose: Verify ownership for authorization ${fields.authorizationId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expires At: ${fields.expiresAt.toISOString()}`,
  ].join('\n')
}

const PATTERN = new RegExp(
  [
    `^${CHALLENGE_TITLE}`,
    'Address: (0x[0-9a-fA-F]{40})',
    'Network: ([a-z0-9-]{1,40}) \\(chainId (\\d{1,12}|n/a)\\)',
    'Purpose: Verify ownership for authorization ([0-9a-f-]{36})',
    'Nonce: ([0-9a-f]{64})',
    'Issued At: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)',
    'Expires At: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)$',
  ].join('\\n'),
)

/** Parses a message; returns null unless it is exactly a well-formed challenge. */
export function parseChallengeMessage(message: string): ChallengeFields | null {
  const m = PATTERN.exec(message)
  if (!m) return null
  const [, address, networkName, chainId, authorizationId, nonce, issuedAt, expiresAt] = m
  const issued = new Date(issuedAt!)
  const expires = new Date(expiresAt!)
  if (Number.isNaN(issued.getTime()) || Number.isNaN(expires.getTime()) || expires <= issued)
    return null
  return {
    address: address!,
    networkName: networkName!,
    chainId: chainId === 'n/a' ? null : Number(chainId),
    authorizationId: authorizationId!,
    nonce: nonce!,
    issuedAt: issued,
    expiresAt: expires,
  }
}
