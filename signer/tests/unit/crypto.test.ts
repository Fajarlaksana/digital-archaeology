import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@da/shared'
import { open, pack, seal, unpack, wipe } from '../../src/crypto/aead'
import { deriveKek, vaultPassphraseViolation } from '../../src/crypto/kdf'
import { createUnlockState } from '../../src/vault/unlock-state'

const FAST_KDF = { memoryCost: 4096, timeCost: 1, parallelism: 1 }

describe('AES-256-GCM with associated data', () => {
  const key = randomBytes(32)
  const secret = Buffer.from('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318')

  it('round-trips and uses a fresh IV each time', () => {
    const a = seal(key, secret, 'addr:0xabc')
    const b = seal(key, secret, 'addr:0xabc')
    expect(a.iv.equals(b.iv)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
    expect(open(key, a, 'addr:0xabc').equals(secret)).toBe(true)
  })

  it('never contains the plaintext', () => {
    const sealed = pack(seal(key, secret, 'x'))
    expect(sealed.includes(secret)).toBe(false)
  })

  it('refuses a different AAD (ciphertext cannot be moved to another address)', () => {
    const sealed = seal(key, secret, 'addr:0xabc')
    expect(() => open(key, sealed, 'addr:0xdef')).toThrow()
  })

  it('refuses a wrong key', () => {
    expect(() => open(randomBytes(32), seal(key, secret, 'x'), 'x')).toThrow()
  })

  it.each(['iv', 'tag', 'ciphertext'] as const)('detects tampering with the %s', (part) => {
    const sealed = seal(key, secret, 'x')
    sealed[part][0] = (sealed[part][0] ?? 0) ^ 0xff
    expect(() => open(key, sealed, 'x')).toThrow()
  })

  it('packs and unpacks', () => {
    const sealed = seal(key, secret, 'x')
    expect(open(key, unpack(pack(sealed)), 'x').equals(secret)).toBe(true)
    expect(() => unpack(Buffer.alloc(10))).toThrow()
  })

  it('rejects keys of the wrong length', () => {
    expect(() => seal(randomBytes(16), secret, 'x')).toThrow(/32 bytes/)
  })

  it('wipe() zeroes buffers', () => {
    const buf = Buffer.from([1, 2, 3])
    wipe(buf, null, undefined)
    expect([...buf]).toEqual([0, 0, 0])
  })
})

describe('Argon2id KDF', () => {
  const salt = randomBytes(16)

  it('is deterministic for the same passphrase + salt and returns 32 bytes', async () => {
    const a = await deriveKek('correct horse battery staple', salt, FAST_KDF)
    const b = await deriveKek('correct horse battery staple', salt, FAST_KDF)
    expect(a.length).toBe(32)
    expect(a.equals(b)).toBe(true)
  })

  it('differs with another salt or passphrase', async () => {
    const base = await deriveKek('correct horse battery staple', salt, FAST_KDF)
    expect(
      base.equals(await deriveKek('correct horse battery staple', randomBytes(16), FAST_KDF)),
    ).toBe(false)
    expect(base.equals(await deriveKek('correct horse battery stapler', salt, FAST_KDF))).toBe(
      false,
    )
  })

  it('requires a 16-byte salt', async () => {
    await expect(deriveKek('x'.repeat(20), randomBytes(8), FAST_KDF)).rejects.toThrow(/16 bytes/)
  })
})

describe('vault passphrase policy', () => {
  it.each([
    ['too short', 'short words', /at least 16/],
    ['leading space', ' long enough passphrase here', /whitespace/],
  ])('rejects %s', (_label, value, message) => {
    expect(vaultPassphraseViolation(value)).toMatch(message)
  })

  it('accepts four random words', () => {
    expect(vaultPassphraseViolation('marble orbit cactus lantern')).toBeNull()
  })
})

describe('unlock state (master key in memory)', () => {
  function setup() {
    let t = 1_000_000
    const onExpire = vi.fn()
    const state = createUnlockState({ ttlMs: 10 * 60_000, now: () => t, onExpire })
    return { state, onExpire, advance: (ms: number) => (t += ms) }
  }

  it('copies the key and wipes the caller buffer', async () => {
    const { state } = setup()
    const input = Buffer.alloc(32, 7)
    state.set(input, 'actor-1')
    expect([...input].every((b) => b === 0)).toBe(true)
    await state.use((mk) => expect(mk.every((b) => b === 7)).toBe(true))
    state.clear()
  })

  it('throws VAULT_LOCKED when locked', async () => {
    const { state } = setup()
    await expect(state.use(() => 1)).rejects.toBeInstanceOf(AppError)
    await expect(state.use(() => 1)).rejects.toMatchObject({ code: 'VAULT_LOCKED' })
  })

  it('expires after the TTL, wipes the key and reports it once', async () => {
    const { state, onExpire, advance } = setup()
    let held: Buffer | null = null
    state.set(Buffer.alloc(32, 9), 'actor-1')
    await state.use((mk) => {
      held = mk // test-only: keep a reference to prove it gets zeroed
    })
    advance(10 * 60_000)
    expect(state.status()).toMatchObject({ unlocked: false, unlockedBy: null, expiresAt: null })
    expect(held!.every((b) => b === 0)).toBe(true)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith('actor-1')
    state.status()
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('clear() reports whether it was unlocked', () => {
    const { state } = setup()
    expect(state.clear()).toBe(false)
    state.set(Buffer.alloc(32, 1), 'a')
    expect(state.clear()).toBe(true)
  })
})
