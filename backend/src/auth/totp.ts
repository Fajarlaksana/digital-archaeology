import { generateSecret, generateSync, generateURI, verifySync } from 'otplib'

const ISSUER = 'Digital Archaeology'
/** Accept the previous and next 30-second window to tolerate small clock drift. */
const EPOCH_TOLERANCE_SECONDS = 30

export function newTotpSecret(): string {
  return generateSecret()
}

export function totpUri(secret: string, accountLabel: string): string {
  return generateURI({ issuer: ISSUER, label: accountLabel, secret })
}

export type TotpCheck = { valid: true; timeStep: number } | { valid: false }

/**
 * Verifies a 6-digit code. Codes from `lastUsedStep` or earlier are rejected,
 * so an intercepted code cannot be replayed.
 */
export function checkTotp(
  secret: string,
  code: string,
  now: Date,
  lastUsedStep: number | null,
): TotpCheck {
  if (!/^\d{6}$/.test(code)) return { valid: false }
  const result = verifySync({
    secret,
    token: code,
    epoch: Math.floor(now.getTime() / 1000),
    epochTolerance: EPOCH_TOLERANCE_SECONDS,
    ...(lastUsedStep === null ? {} : { afterTimeStep: lastUsedStep }),
  })
  return result.valid && 'timeStep' in result
    ? { valid: true, timeStep: result.timeStep }
    : { valid: false }
}

/** Test helper / CLI helper: the code an authenticator app would show at `now`. */
export function totpCodeAt(secret: string, now: Date): string {
  return generateSync({ secret, epoch: Math.floor(now.getTime() / 1000) })
}
