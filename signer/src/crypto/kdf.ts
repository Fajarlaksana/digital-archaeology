import argon2 from 'argon2'

/** Passphrase → 32-byte key-encryption key (KEK) with Argon2id. Parameters are stored per vault. */
export interface KdfParams {
  memoryCost: number
  timeCost: number
  parallelism: number
}

/** OWASP-recommended baseline for Argon2id (64 MiB, 3 passes). */
export const DEFAULT_KDF: KdfParams = { memoryCost: 65_536, timeCost: 3, parallelism: 1 }
export const KDF_ALGORITHM = 'argon2id'
export const SALT_BYTES = 16

export async function deriveKek(
  passphrase: string,
  salt: Buffer,
  params: KdfParams,
): Promise<Buffer> {
  if (salt.length !== SALT_BYTES) throw new Error('Salt must be 16 bytes')
  return argon2.hash(passphrase, {
    type: argon2.argon2id,
    raw: true,
    salt,
    hashLength: 32,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  })
}

export const PASSPHRASE_MIN_LENGTH = 16
export const PASSPHRASE_MAX_LENGTH = 1024

/** Returns a reason when the passphrase is not acceptable for the vault, otherwise null. */
export function vaultPassphraseViolation(passphrase: string): string | null {
  if (passphrase.length < PASSPHRASE_MIN_LENGTH) {
    return `Passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters (e.g. 4–5 random words)`
  }
  if (passphrase.length > PASSPHRASE_MAX_LENGTH) return 'Passphrase is too long'
  if (passphrase.trim() !== passphrase) return 'Passphrase must not start or end with whitespace'
  return null
}
