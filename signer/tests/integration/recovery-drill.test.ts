import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createLogger } from '@da/shared'
import { createKeyService } from '../../src/keys/key.service'
import { runRecoveryDrill } from '../../src/vault/recovery-drill'
import {
  createVaultDatabase,
  createVaultRepository,
  type VaultDatabase,
} from '../../src/vault/vault.repository'
import { createVaultService } from '../../src/vault/vault.service'

/* PUBLIC TEST VECTORS (Hardhat / Anvil) — never real funds. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const MNEMONIC = 'test test test test test test test test test test test junk'
const MNEMONIC_ADDRESS_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const MNEMONIC_PATH_1 = "m/44'/60'/0'/0/1"
const PASSPHRASE = 'marble orbit cactus lantern'
const RECOVERY = 'violet harbor tundra pencil quartz'

const vaultUrl = inject('testDatabaseUrl')
const logger = createLogger({ name: 'drill-test', level: 'silent' })

describe.skipIf(!vaultUrl)('vault recovery drill (Phase 14)', () => {
  let db: VaultDatabase

  beforeAll(() => {
    db = createVaultDatabase(vaultUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })

  async function populatedVault() {
    await db.vaultKey.deleteMany({})
    await db.vaultConfig.deleteMany({})
    const repo = createVaultRepository(db)
    const vault = createVaultService({
      repo,
      logger,
      unlockTtlMs: 600_000,
      kdf: { memoryCost: 4096, timeCost: 1, parallelism: 1 },
    })
    const actor = randomUUID()
    await vault.init({ passphrase: PASSPHRASE, recoveryPassphrase: RECOVERY, actor })
    await vault.unlock({ passphrase: PASSPHRASE, actor })
    const keys = createKeyService({ db, repo, vault, logger, revealEnabled: false })
    await keys.import({
      actor,
      expectedAddress: TEST_ADDRESS,
      secretType: 'PRIVATE_KEY',
      secret: TEST_KEY,
    })
    await keys.import({
      actor,
      expectedAddress: MNEMONIC_ADDRESS_1,
      secretType: 'MNEMONIC',
      secret: MNEMONIC,
      derivationPath: MNEMONIC_PATH_1,
    })
    vault.shutdown() // as if the server died: only the database + recovery passphrase remain
    return repo
  }

  it('recovers every key from the database and the recovery passphrase alone, and signs', async () => {
    const repo = await populatedVault()
    const result = await runRecoveryDrill({ db, repo, logger, recoveryPassphrase: RECOVERY })
    expect(result).toEqual({ keysChecked: 2, mismatches: [], signedTestTransaction: true })
    const events = (await db.vaultEvent.findMany({ orderBy: { sequence: 'desc' }, take: 3 })).map(
      (e) => e.type,
    )
    expect(events).toEqual(['LOCK', 'UNLOCK', 'RECOVERED'])
  })

  it('fails with a wrong recovery passphrase, and does not pass a tampered key row', async () => {
    const repo = await populatedVault()
    await expect(
      runRecoveryDrill({ db, repo, logger, recoveryPassphrase: 'not the recovery phrase' }),
    ).rejects.toMatchObject({ code: 'PASSPHRASE_INVALID' })

    // Point a row at another address: the AAD (chain + address) makes decryption fail,
    // so the drill must not report success.
    await db.vaultKey.updateMany({
      where: { address: TEST_ADDRESS.toLowerCase() },
      data: { address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' },
    })
    await expect(
      runRecoveryDrill({ db, repo, logger, recoveryPassphrase: RECOVERY }),
    ).rejects.toThrow()
  })
})
