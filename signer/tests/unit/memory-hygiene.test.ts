import { randomBytes } from 'node:crypto'
import type * as NodeCrypto from 'node:crypto'
import type * as Bip39 from '@scure/bip39'
import { HDKey } from '@scure/bip32'
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * Key material must not linger in buffers the code cannot reach any more (ADR-017).
 * The crypto and BIP-39 modules are wrapped so the test can inspect the intermediates
 * that the production code is responsible for wiping.
 */
const captured = vi.hoisted(() => ({ decipher: [] as Buffer[], seeds: [] as Uint8Array[] }))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return {
    ...actual,
    createDecipheriv: (...args: Parameters<typeof actual.createDecipheriv>) => {
      const decipher = actual.createDecipheriv(...args)
      const update = decipher.update.bind(decipher) as (data: Buffer) => Buffer
      const final = decipher.final.bind(decipher) as () => Buffer
      Object.assign(decipher, {
        update: (data: Buffer) => {
          const out = update(data)
          captured.decipher.push(out)
          return out
        },
        final: () => {
          const out = final()
          captured.decipher.push(out)
          return out
        },
      })
      return decipher
    },
  }
})

vi.mock('@scure/bip39', async (importOriginal) => {
  const actual = await importOriginal<typeof Bip39>()
  return {
    ...actual,
    mnemonicToSeedSync: (...args: Parameters<typeof actual.mnemonicToSeedSync>) => {
      const seed = actual.mnemonicToSeedSync(...args)
      captured.seeds.push(seed)
      return seed
    },
  }
})

const { open, seal } = await import('../../src/crypto/aead')
const { deriveEvmKey } = await import('../../src/keys/derive')

/* PUBLIC TEST VECTOR (Hardhat / Anvil) — never real funds. */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const isZero = (b: Uint8Array) => b.every((byte) => byte === 0)

afterEach(() => {
  captured.decipher.length = 0
  captured.seeds.length = 0
  vi.restoreAllMocks()
})

describe('aead.open', () => {
  const key = randomBytes(32)
  const secret = randomBytes(32)

  it('wipes the intermediate plaintext; only the returned buffer holds the secret', () => {
    const result = open(key, seal(key, secret, 'x'), 'x')
    expect(result.equals(secret)).toBe(true)
    expect(captured.decipher.length).toBeGreaterThan(0)
    expect(captured.decipher.every(isZero)).toBe(true)
  })

  it('also wipes the unauthenticated plaintext when the tag check fails', () => {
    const sealed = seal(key, secret, 'x')
    sealed.tag[0] = (sealed.tag[0] ?? 0) ^ 0xff
    expect(() => open(key, sealed, 'x')).toThrow()
    expect(captured.decipher.length).toBeGreaterThan(0)
    expect(captured.decipher.every(isZero)).toBe(true)
  })
})

describe('seed phrase derivation', () => {
  it('wipes the BIP-39 seed and every HD node, and still derives the right key', () => {
    const wipeNode = vi.spyOn(HDKey.prototype, 'wipePrivateData')
    const derived = deriveEvmKey({ secretType: 'MNEMONIC', secret: TEST_MNEMONIC })
    expect(derived.address).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
    expect(captured.seeds).toHaveLength(1)
    expect(isZero(captured.seeds[0]!)).toBe(true)
    // m/44'/60'/0'/0/0: the master node, four intermediate nodes and the final node.
    expect(wipeNode).toHaveBeenCalledTimes(6)
  })

  it('wipes the seed when derivation is refused', () => {
    expect(() =>
      deriveEvmKey({
        secretType: 'MNEMONIC',
        secret: TEST_MNEMONIC,
        derivationPath: 'm/9999999999',
      }),
    ).toThrow()
    expect(captured.seeds.every(isZero)).toBe(true)
  })
})
