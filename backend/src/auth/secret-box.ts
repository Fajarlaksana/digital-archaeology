import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM encryption for small secrets stored in the application DB (TOTP secrets).
 * Format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
 */
const VERSION = 'v1:'
const IV_BYTES = 12
const TAG_BYTES = 16

export function createSecretBox(keyBase64: string) {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) throw new Error('Secret box key must be 32 bytes')

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return VERSION + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
    },

    decrypt(payload: string): string {
      if (!payload.startsWith(VERSION)) throw new Error('Unsupported secret box payload')
      const raw = Buffer.from(payload.slice(VERSION.length), 'base64')
      if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('Secret box payload too short')
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES))
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
      return Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8')
    },
  }
}

export type SecretBox = ReturnType<typeof createSecretBox>
