import argon2 from 'argon2'

/** OWASP-recommended argon2id baseline: 64 MiB, 3 iterations. */
const OPTIONS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

let dummyHash: Promise<string> | undefined

/**
 * Burns the same CPU time as a real verification. Used when the email does not exist,
 * so response timing does not reveal which accounts are registered.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalisation')
  await verifyPassword(await dummyHash, password)
  return false
}

/** Returns a human-readable reason, or null when the password is acceptable. */
export function passwordPolicyViolation(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`
  }
  if (password.trim() !== password) return 'Password must not start or end with whitespace'
  return null
}
