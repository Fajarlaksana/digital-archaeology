import { createHash, randomBytes } from 'node:crypto'

export const SESSION_COOKIE = 'da_session'

/** 256-bit random token for the cookie. Only its hash is stored, so a DB leak yields no sessions. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
