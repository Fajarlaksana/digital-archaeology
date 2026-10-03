import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM with associated data (AAD). The AAD is authenticated but not stored with the
 * ciphertext: decrypting with a different AAD fails. We use it to bind every ciphertext to
 * its purpose / address, so rows cannot be swapped inside the database (ADR-008/017).
 */
export const KEY_BYTES = 32
export const IV_BYTES = 12
export const TAG_BYTES = 16

export interface Sealed {
  iv: Buffer
  tag: Buffer
  ciphertext: Buffer
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM key must be 32 bytes')
}

export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  assertKey(key)
  const iv = randomBytes(IV_BYTES) // fresh IV every time — never reused with the same key
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv, tag: cipher.getAuthTag(), ciphertext }
}

/** Throws if the key, AAD, IV, tag or ciphertext is wrong — no partial plaintext is returned. */
export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  assertKey(key)
  if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) {
    throw new Error('Malformed sealed data')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(sealed.tag)
  // update() already returns the (not yet authenticated) plaintext; final() verifies the tag.
  // Both intermediates are wiped, also on failure, so only the returned copy holds the secret.
  const parts: Buffer[] = []
  try {
    parts.push(decipher.update(sealed.ciphertext))
    parts.push(decipher.final())
    return Buffer.concat(parts)
  } finally {
    wipe(...parts)
  }
}

/** iv | tag | ciphertext, for single-column storage (wrapped master key). */
export function pack(sealed: Sealed): Buffer {
  return Buffer.concat([sealed.iv, sealed.tag, sealed.ciphertext])
}

export function unpack(packed: Buffer): Sealed {
  if (packed.length <= IV_BYTES + TAG_BYTES) throw new Error('Malformed sealed data')
  return {
    iv: packed.subarray(0, IV_BYTES),
    tag: packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    ciphertext: packed.subarray(IV_BYTES + TAG_BYTES),
  }
}

/** Overwrites a buffer with zeros. Call as soon as key material is no longer needed. */
export function wipe(...buffers: Array<Buffer | null | undefined>): void {
  for (const buffer of buffers) buffer?.fill(0)
}
