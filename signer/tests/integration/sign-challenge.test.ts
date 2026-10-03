import { randomUUID } from 'node:crypto'
import { verifyMessage } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildChallengeMessage, createLogger } from '@da/shared'
import { createKeyService, type KeyService } from '../../src/keys/key.service'
import {
  createVaultDatabase,
  createVaultRepository,
  type VaultDatabase,
} from '../../src/vault/vault.repository'
import { createVaultService, type VaultService } from '../../src/vault/vault.service'

/* PUBLIC TEST VECTOR (Hardhat / Anvil account #0) — never real funds. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const testDatabaseUrl = inject('testDatabaseUrl')
const PASSPHRASE = 'marble orbit cactus lantern'
const ACTOR = randomUUID()

describe.skipIf(!testDatabaseUrl)('signing ownership challenges (signer)', () => {
  let db: VaultDatabase
  let vault: VaultService
  let keys: KeyService
  let clock: number

  beforeAll(() => {
    db = createVaultDatabase(testDatabaseUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })
  afterEach(() => vault?.shutdown())

  async function setup() {
    await db.vaultKey.deleteMany({})
    await db.vaultConfig.deleteMany({})
    clock = Date.now()
    const logger = createLogger({ name: 'sign-test', level: 'silent' })
    const repo = createVaultRepository(db)
    vault = createVaultService({
      repo,
      logger,
      unlockTtlMs: 600_000,
      kdf: { memoryCost: 4096, timeCost: 1, parallelism: 1 },
      now: () => clock,
    })
    keys = createKeyService({ db, repo, vault, logger, revealEnabled: true, now: () => clock })
    await vault.init({
      passphrase: PASSPHRASE,
      recoveryPassphrase: 'violet harbor tundra pencil quartz',
      actor: ACTOR,
    })
    await vault.unlock({ passphrase: PASSPHRASE, actor: ACTOR })
    await keys.import({
      actor: ACTOR,
      expectedAddress: TEST_ADDRESS,
      secretType: 'PRIVATE_KEY',
      secret: TEST_KEY,
    })
  }

  const challenge = (overrides: { address?: string; expiresInMs?: number } = {}) =>
    buildChallengeMessage({
      address: overrides.address ?? TEST_ADDRESS,
      networkName: 'sepolia',
      chainId: 11155111,
      authorizationId: randomUUID(),
      nonce: 'b'.repeat(64),
      issuedAt: new Date(clock - 1000),
      expiresAt: new Date(clock + (overrides.expiresInMs ?? 15 * 60_000)),
    })

  it('signs a valid challenge; the signature verifies for the address', async () => {
    await setup()
    const message = challenge()
    const { signature } = await keys.signChallenge({ actor: ACTOR, address: TEST_ADDRESS, message })
    expect(
      await verifyMessage({
        address: TEST_ADDRESS,
        message,
        signature: signature as `0x${string}`,
      }),
    ).toBe(true)

    const event = await db.vaultEvent.findFirst({
      where: { type: 'MESSAGE_SIGNED' },
      orderBy: { sequence: 'desc' },
    })
    expect(event?.metadata).toMatchObject({
      kind: 'OWNERSHIP_CHALLENGE',
      messageSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect((await db.vaultKey.findFirstOrThrow()).lastUsedAt).not.toBeNull()
  })

  it.each([
    ['an arbitrary message', 'I approve spending all my tokens'],
    ['a dApp login', 'example.com wants you to sign in with your Ethereum account'],
    ['a challenge with an extra line', () => challenge() + '\nAlso: transfer everything'],
  ])('refuses to sign %s', async (_label, message) => {
    await setup()
    const text = typeof message === 'function' ? message() : message
    await expect(
      keys.signChallenge({ actor: ACTOR, address: TEST_ADDRESS, message: text }),
    ).rejects.toThrow(/Only ownership-verification challenges/)
  })

  it('refuses a challenge for another address, an expired one, or while locked', async () => {
    await setup()
    await expect(
      keys.signChallenge({
        actor: ACTOR,
        address: TEST_ADDRESS,
        message: challenge({ address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }),
      }),
    ).rejects.toThrow(/different address/)
    await expect(
      keys.signChallenge({
        actor: ACTOR,
        address: TEST_ADDRESS,
        message: challenge({ expiresInMs: -1 }),
      }),
    ).rejects.toThrow()
    await vault.lock({ actor: ACTOR })
    await expect(
      keys.signChallenge({ actor: ACTOR, address: TEST_ADDRESS, message: challenge() }),
    ).rejects.toMatchObject({
      code: 'VAULT_LOCKED',
    })
  })
})
