import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { createLogger } from '@da/shared'
import { open } from '../../src/crypto/aead'
import { DEFAULT_EVM_PATH, deriveEvmKey } from '../../src/keys/derive'
import { createKeyService, keyAad, type KeyService } from '../../src/keys/key.service'
import {
  createVaultDatabase,
  createVaultRepository,
  type VaultDatabase,
} from '../../src/vault/vault.repository'
import { createVaultService, type VaultService } from '../../src/vault/vault.service'

/*
 * PUBLIC TEST VECTORS (Hardhat / Anvil defaults). They are published on purpose so that
 * anyone can test with them; they never hold real funds. Never use them for anything else.
 */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const ACCOUNT_0 = {
  address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  path: "m/44'/60'/0'/0/0",
}
const ACCOUNT_1 = {
  address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  path: "m/44'/60'/0'/0/1",
}
const ACCOUNT_0_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const testDatabaseUrl = inject('testDatabaseUrl')
const FAST_KDF = { memoryCost: 4096, timeCost: 1, parallelism: 1 }
const PASSPHRASE = 'marble orbit cactus lantern'
const RECOVERY = 'violet harbor tundra pencil quartz'
const ACTOR = randomUUID()

describe('key derivation', () => {
  it('derives the address from a raw private key (with or without 0x)', () => {
    for (const secret of [
      ACCOUNT_0_KEY,
      ACCOUNT_0_KEY.slice(2),
      ACCOUNT_0_KEY.toUpperCase().replace('0X', '0x'),
    ]) {
      const key = deriveEvmKey({ secretType: 'PRIVATE_KEY', secret })
      expect(key).toMatchObject({
        address: ACCOUNT_0.address,
        keyType: 'PRIVATE_KEY',
        derivationPath: null,
      })
      expect(key.privateKey.toString('hex')).toBe(ACCOUNT_0_KEY.slice(2))
    }
  })

  it('derives one key from a seed phrase at the given path (default index 0)', () => {
    expect(deriveEvmKey({ secretType: 'MNEMONIC', secret: TEST_MNEMONIC }).address).toBe(
      ACCOUNT_0.address,
    )
    expect(
      deriveEvmKey({
        secretType: 'MNEMONIC',
        secret: `  ${TEST_MNEMONIC.toUpperCase()}  `,
        derivationPath: ACCOUNT_1.path,
      }),
    ).toMatchObject({
      address: ACCOUNT_1.address,
      keyType: 'DERIVED_FROM_MNEMONIC',
      derivationPath: ACCOUNT_1.path,
    })
    expect(DEFAULT_EVM_PATH).toBe(ACCOUNT_0.path)
  })

  it.each([
    ['short hex', { secretType: 'PRIVATE_KEY' as const, secret: '0x1234' }, /64 hexadecimal/],
    [
      'zero key',
      { secretType: 'PRIVATE_KEY' as const, secret: '0x' + '0'.repeat(64) },
      /secp256k1/,
    ],
    [
      'bad checksum seed',
      {
        secretType: 'MNEMONIC' as const,
        secret: 'test test test test test test test test test test test test',
      },
      /BIP-39/,
    ],
    [
      'bad path',
      { secretType: 'MNEMONIC' as const, secret: TEST_MNEMONIC, derivationPath: '44/60/0' },
      /Derivation path/,
    ],
  ])('rejects %s without quoting the input', (_label, input, message) => {
    let error: Error | undefined
    try {
      deriveEvmKey(input)
    } catch (e) {
      error = e as Error
    }
    expect(error?.message).toMatch(message)
    expect(error?.message).not.toContain(input.secret.slice(2, 12))
  })
})

describe.skipIf(!testDatabaseUrl)('vault keys (signer)', () => {
  let db: VaultDatabase
  let vault: VaultService
  let keys: KeyService
  let logLines: string[]
  let clock: number

  beforeAll(() => {
    db = createVaultDatabase(testDatabaseUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })
  afterEach(() => vault?.shutdown())

  async function setup(opts: { unlock?: boolean; revealEnabled?: boolean } = {}) {
    await db.vaultKey.deleteMany({})
    await db.vaultConfig.deleteMany({})
    clock = Date.now()
    logLines = []
    const logger = createLogger({
      name: 'keys-test',
      level: 'trace',
      destination: new Writable({
        write(chunk: Buffer, _e, cb) {
          logLines.push(chunk.toString())
          cb()
        },
      }),
    })
    const repo = createVaultRepository(db)
    vault = createVaultService({
      repo,
      logger,
      unlockTtlMs: 600_000,
      kdf: FAST_KDF,
      now: () => clock,
    })
    keys = createKeyService({
      db,
      repo,
      vault,
      logger,
      revealEnabled: opts.revealEnabled ?? true,
      now: () => clock,
    })
    await vault.init({ passphrase: PASSPHRASE, recoveryPassphrase: RECOVERY, actor: ACTOR })
    if (opts.unlock ?? true) await vault.unlock({ passphrase: PASSPHRASE, actor: ACTOR })
  }

  it('imports a raw key: stores only ciphertext bound to the address', async () => {
    await setup()
    const key = await keys.import({
      actor: ACTOR,
      expectedAddress: ACCOUNT_0.address,
      secretType: 'PRIVATE_KEY',
      secret: ACCOUNT_0_KEY,
    })
    expect(key).toMatchObject({
      address: ACCOUNT_0.address,
      keyType: 'PRIVATE_KEY',
      importedBy: ACTOR,
    })

    const row = await db.vaultKey.findFirstOrThrow({ where: { address: ACCOUNT_0.address } })
    const plainBytes = Buffer.from(ACCOUNT_0_KEY.slice(2), 'hex')
    expect(Buffer.from(row.ciphertext).includes(plainBytes)).toBe(false)
    expect(
      JSON.stringify(row, (_k, v) =>
        v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v,
      ),
    ).not.toContain(ACCOUNT_0_KEY.slice(2))

    // The ciphertext decrypts only with its own address as AAD (rows cannot be swapped).
    const sealed = {
      iv: Buffer.from(row.iv),
      tag: Buffer.from(row.authTag),
      ciphertext: Buffer.from(row.ciphertext),
    }
    await vault.withMasterKey((mk) => {
      expect(open(mk, sealed, keyAad('EVM', ACCOUNT_0.address)).equals(plainBytes)).toBe(true)
      expect(() => open(mk, sealed, keyAad('EVM', ACCOUNT_1.address))).toThrow()
    })
  })

  it('imports from a seed phrase but stores ONLY the derived key — never the seed', async () => {
    await setup()
    await keys.import({
      actor: ACTOR,
      expectedAddress: ACCOUNT_1.address,
      secretType: 'MNEMONIC',
      secret: TEST_MNEMONIC,
      derivationPath: ACCOUNT_1.path,
    })
    const row = await db.vaultKey.findFirstOrThrow({ where: { address: ACCOUNT_1.address } })
    expect(row).toMatchObject({ keyType: 'DERIVED_FROM_MNEMONIC', derivationPath: ACCOUNT_1.path })
    expect(row.ciphertext.length).toBe(32) // exactly one 32-byte key, not a phrase

    const everything =
      JSON.stringify(await db.vaultKey.findMany()) +
      JSON.stringify(await db.vaultEvent.findMany(), (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ) +
      logLines.join('')
    expect(everything).not.toContain('test test test')
    expect(everything).not.toContain('junk')
  })

  it('refuses a key that does not control the selected address, and stores nothing', async () => {
    await setup()
    await expect(
      keys.import({
        actor: ACTOR,
        expectedAddress: ACCOUNT_1.address,
        secretType: 'PRIVATE_KEY',
        secret: ACCOUNT_0_KEY,
      }),
    ).rejects.toMatchObject({ code: 'KEY_ADDRESS_MISMATCH' })
    await expect(
      keys.import({
        actor: ACTOR,
        expectedAddress: ACCOUNT_1.address,
        secretType: 'MNEMONIC',
        secret: TEST_MNEMONIC,
      }),
    ).rejects.toThrow(/derivation path does not control/)
    expect(await db.vaultKey.count()).toBe(0)
  })

  it('needs the vault unlocked to import, and rejects duplicates', async () => {
    await setup({ unlock: false })
    await expect(
      keys.import({
        actor: ACTOR,
        expectedAddress: ACCOUNT_0.address,
        secretType: 'PRIVATE_KEY',
        secret: ACCOUNT_0_KEY,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED' })
    await vault.unlock({ passphrase: PASSPHRASE, actor: ACTOR })
    await keys.import({
      actor: ACTOR,
      expectedAddress: ACCOUNT_0.address,
      secretType: 'PRIVATE_KEY',
      secret: ACCOUNT_0_KEY,
    })
    await expect(
      keys.import({
        actor: ACTOR,
        expectedAddress: ACCOUNT_0.address,
        secretType: 'MNEMONIC',
        secret: TEST_MNEMONIC,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('lists keys without any key material', async () => {
    await setup()
    await keys.import({
      actor: ACTOR,
      expectedAddress: ACCOUNT_0.address,
      secretType: 'PRIVATE_KEY',
      secret: ACCOUNT_0_KEY,
    })
    const list = await keys.list()
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]!).sort()).toEqual([
      'address',
      'chainType',
      'createdAt',
      'derivationPath',
      'importedBy',
      'keyType',
      'lastUsedAt',
    ])
  })

  describe('break-glass reveal', () => {
    it('returns the key only with the passphrase, even while locked, and records it', async () => {
      await setup()
      await keys.import({
        actor: ACTOR,
        expectedAddress: ACCOUNT_0.address,
        secretType: 'PRIVATE_KEY',
        secret: ACCOUNT_0_KEY,
      })
      await vault.lock({ actor: ACTOR })

      expect(
        await keys.reveal({ actor: ACTOR, address: ACCOUNT_0.address, passphrase: PASSPHRASE }),
      ).toEqual({
        privateKey: ACCOUNT_0_KEY,
      })
      const event = await db.vaultEvent.findFirst({
        where: { type: 'KEY_REVEALED' },
        orderBy: { sequence: 'desc' },
      })
      expect(event).toMatchObject({ actor: ACTOR, address: ACCOUNT_0.address })
      expect(JSON.stringify(event?.metadata ?? null)).not.toContain(ACCOUNT_0_KEY.slice(2))
      expect(logLines.join('')).not.toContain(ACCOUNT_0_KEY.slice(2))
    })

    it('rejects a wrong passphrase and counts it towards the throttle', async () => {
      await setup()
      await keys.import({
        actor: ACTOR,
        expectedAddress: ACCOUNT_0.address,
        secretType: 'PRIVATE_KEY',
        secret: ACCOUNT_0_KEY,
      })
      await expect(
        keys.reveal({
          actor: ACTOR,
          address: ACCOUNT_0.address,
          passphrase: 'not the passphrase at all',
        }),
      ).rejects.toMatchObject({ code: 'PASSPHRASE_INVALID' })
      expect(await db.vaultEvent.count({ where: { type: 'REVEAL_FAILED' } })).toBeGreaterThan(0)
    })

    it('allows at most 3 reveals per hour', async () => {
      await setup()
      await keys.import({
        actor: ACTOR,
        expectedAddress: ACCOUNT_0.address,
        secretType: 'PRIVATE_KEY',
        secret: ACCOUNT_0_KEY,
      })
      for (let i = 0; i < 3; i++)
        await keys.reveal({ actor: ACTOR, address: ACCOUNT_0.address, passphrase: PASSPHRASE })
      await expect(
        keys.reveal({ actor: ACTOR, address: ACCOUNT_0.address, passphrase: PASSPHRASE }),
      ).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      })
      clock += 3_600_001
      await expect(
        keys.reveal({ actor: ACTOR, address: ACCOUNT_0.address, passphrase: PASSPHRASE }),
      ).resolves.toBeDefined()
    })

    it('can be switched off entirely (KEY_REVEAL_ENABLED=false)', async () => {
      await setup({ revealEnabled: false })
      await keys.import({
        actor: ACTOR,
        expectedAddress: ACCOUNT_0.address,
        secretType: 'PRIVATE_KEY',
        secret: ACCOUNT_0_KEY,
      })
      await expect(
        keys.reveal({ actor: ACTOR, address: ACCOUNT_0.address, passphrase: PASSPHRASE }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    })

    it('reports a missing key', async () => {
      await setup()
      await expect(
        keys.reveal({ actor: ACTOR, address: ACCOUNT_1.address, passphrase: PASSPHRASE }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })
  })
})
