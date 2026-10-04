import { randomInt, randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import pg from 'pg'
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { createLogger } from '@da/shared'
import { createKeyService } from '../../src/keys/key.service'
import {
  createPgApprovedTransactionSource,
  type ApprovedTransactionRecord,
  type ApprovedTransactionSource,
} from '../../src/transactions/approved-source'
import { createTransactionSigner } from '../../src/transactions/sign-transaction'
import {
  createVaultDatabase,
  createVaultRepository,
  type VaultDatabase,
} from '../../src/vault/vault.repository'
import { createVaultService, type VaultService } from '../../src/vault/vault.service'

/* PUBLIC TEST VECTORS (Hardhat / Anvil accounts #0 and #1) — never real funds. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const DEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const vaultUrl = inject('testDatabaseUrl')
const appUrl = inject('testAppDatabaseUrl')
const readonlyUrl = inject('testAppReadonlyUrl')
const PASSPHRASE = 'marble orbit cactus lantern'
const GWEI = 10n ** 9n

function unsignedTx(chainId: number, nonce: number, value = 10n ** 17n) {
  const tx: TransactionSerializableEIP1559 = {
    type: 'eip1559',
    chainId,
    nonce,
    to: DEST_ADDRESS,
    value,
    data: '0x',
    gas: 21_000n,
    maxFeePerGas: 25n * GWEI,
    maxPriorityFeePerGas: GWEI,
  }
  const serialized = serializeTransaction(tx)
  return { serialized, hash: keccak256(serialized) }
}

describe.skipIf(!vaultUrl)('signing approved transactions (signer)', () => {
  let db: VaultDatabase
  let vault: VaultService
  let clock: number
  let logLines: string[]
  const actor = { creator: randomUUID(), approver: randomUUID(), signer: randomUUID() }

  beforeAll(() => {
    db = createVaultDatabase(vaultUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })
  afterEach(() => vault?.shutdown())

  async function setup(source: ApprovedTransactionSource | null, opts: { unlock?: boolean } = {}) {
    await db.vaultKey.deleteMany({})
    await db.vaultConfig.deleteMany({})
    clock = Date.now()
    logLines = []
    const logger = createLogger({
      name: 'sign-tx-test',
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
      kdf: { memoryCost: 4096, timeCost: 1, parallelism: 1 },
      now: () => clock,
    })
    const keys = createKeyService({
      db,
      repo,
      vault,
      logger,
      revealEnabled: true,
      now: () => clock,
    })
    await vault.init({
      passphrase: PASSPHRASE,
      recoveryPassphrase: 'violet harbor tundra pencil quartz',
      actor: actor.signer,
    })
    await vault.unlock({ passphrase: PASSPHRASE, actor: actor.signer })
    await keys.import({
      actor: actor.signer,
      expectedAddress: TEST_ADDRESS,
      secretType: 'PRIVATE_KEY',
      secret: TEST_KEY,
    })
    if (opts.unlock === false) await vault.lock({ actor: actor.signer })
    return createTransactionSigner({ source, db, repo, vault, logger, now: () => clock })
  }

  /** In-memory source: lets the policy checks be exercised with records the DB would refuse. */
  function fakeSource(
    overrides: Partial<ApprovedTransactionRecord> = {},
  ): ApprovedTransactionSource {
    const chainId = 11155111
    const { serialized, hash } = unsignedTx(chainId, 7)
    const record: ApprovedTransactionRecord = {
      id: randomUUID(),
      status: 'APPROVED',
      nonce: 7,
      unsignedPayload: { serialized },
      unsignedHash: hash,
      createdBy: actor.creator,
      address: TEST_ADDRESS,
      chainId,
      decisions: [
        {
          decision: 'APPROVED',
          decidedBy: actor.approver,
          expiresAt: new Date(Date.now() + 30 * 60_000),
          approverActive: true,
          approverIsReviewer: true,
        },
      ],
      ...overrides,
    }
    return { load: async (id) => (id === record.id ? record : null), close: async () => {} }
  }

  describe('policy (checked inside the signer, whatever the backend says)', () => {
    async function attempt(
      overrides: Partial<ApprovedTransactionRecord>,
      signerActor = actor.signer,
    ) {
      const id = randomUUID()
      const source = fakeSource({ id, ...overrides })
      const signer = await setup(source)
      return signer.sign({ actor: signerActor, transactionId: id })
    }

    it('signs a valid approved transaction; the signature recovers to the source address', async () => {
      const result = await attempt({})
      const parsed = parseTransaction(result.signedTransaction)
      expect(parsed).toMatchObject({ nonce: 7, chainId: 11155111, value: 10n ** 17n, gas: 21_000n })
      expect(parsed.to?.toLowerCase()).toBe(DEST_ADDRESS.toLowerCase())
      expect(
        await recoverTransactionAddress({ serializedTransaction: result.signedTransaction }),
      ).toBe(TEST_ADDRESS)
      expect(result.txHash).toBe(keccak256(result.signedTransaction))
      const event = await db.vaultEvent.findFirst({
        where: { type: 'TRANSACTION_SIGNED' },
        orderBy: { sequence: 'desc' },
      })
      expect(event?.metadata).toMatchObject({ nonce: 7, chainId: 11155111, txHash: result.txHash })
      const everything =
        JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) +
        logLines.join('')
      expect(everything).not.toContain(TEST_KEY.slice(2))
      expect(everything).not.toContain(result.signedTransaction.slice(2))
    })

    it.each([
      ['not APPROVED', { status: 'CREATED' }, 'CONFLICT'],
      ['no approval at all', { decisions: [] }, 'CONFLICT'],
      [
        'the latest decision is a rejection',
        {
          decisions: [
            {
              decision: 'REJECTED',
              decidedBy: actor.approver,
              expiresAt: null,
              approverActive: true,
              approverIsReviewer: true,
            },
          ],
        },
        'CONFLICT',
      ],
      [
        'approved by the creator',
        {
          decisions: [
            {
              decision: 'APPROVED',
              decidedBy: actor.creator,
              expiresAt: new Date(Date.now() + 60_000),
              approverActive: true,
              approverIsReviewer: true,
            },
          ],
        },
        'SELF_APPROVAL',
      ],
      [
        'approver no longer an active REVIEWER',
        {
          decisions: [
            {
              decision: 'APPROVED',
              decidedBy: actor.approver,
              expiresAt: new Date(Date.now() + 60_000),
              approverActive: false,
              approverIsReviewer: true,
            },
          ],
        },
        'CONFLICT',
      ],
      [
        'approval expired',
        {
          decisions: [
            {
              decision: 'APPROVED',
              decidedBy: actor.approver,
              expiresAt: new Date(Date.now() - 1),
              approverActive: true,
              approverIsReviewer: true,
            },
          ],
        },
        'TRANSACTION_EXPIRED',
      ],
      [
        'payload changed after approval (hash mismatch)',
        { unsignedHash: `0x${'0'.repeat(64)}` },
        'VALIDATION_ERROR',
      ],
      ['wrong chain', { chainId: 1 }, 'VALIDATION_ERROR'],
      ['wrong nonce', { nonce: 8 }, 'VALIDATION_ERROR'],
      [
        'not an EIP-1559 payload',
        { unsignedPayload: { serialized: '0xdeadbeef' } },
        'VALIDATION_ERROR',
      ],
      ['no key for the source', { address: DEST_ADDRESS }, 'NOT_FOUND'],
    ] as const)('refuses: %s', async (_label, overrides, code) => {
      await expect(attempt(overrides as Partial<ApprovedTransactionRecord>)).rejects.toMatchObject({
        code,
      })
    })

    it('the signing user must be a third person', async () => {
      await expect(attempt({}, actor.creator)).rejects.toMatchObject({ code: 'SELF_APPROVAL' })
      await expect(attempt({}, actor.approver)).rejects.toMatchObject({ code: 'SELF_APPROVAL' })
    })

    it('needs the vault unlocked, and the feature configured', async () => {
      const id = randomUUID()
      const locked = await setup(fakeSource({ id }), { unlock: false })
      await expect(locked.sign({ actor: actor.signer, transactionId: id })).rejects.toMatchObject({
        code: 'VAULT_LOCKED',
      })
      const unconfigured = await setup(null)
      await expect(
        unconfigured.sign({ actor: actor.signer, transactionId: id }),
      ).rejects.toMatchObject({
        code: 'SIGNER_UNAVAILABLE',
      })
    })

    it('never signs two different transactions for the same address and nonce', async () => {
      const chainId = randomInt(1_000_000, 2_000_000_000)
      const first = unsignedTx(chainId, 3, 10n ** 17n)
      const second = unsignedTx(chainId, 3, 2n * 10n ** 17n)
      const idA = randomUUID()
      const idB = randomUUID()
      const records = new Map<string, ApprovedTransactionRecord>()
      for (const [id, u] of [
        [idA, first],
        [idB, second],
      ] as const) {
        records.set(id, {
          id,
          status: 'APPROVED',
          nonce: 3,
          unsignedPayload: { serialized: u.serialized },
          unsignedHash: u.hash,
          createdBy: actor.creator,
          address: TEST_ADDRESS,
          chainId,
          decisions: [
            {
              decision: 'APPROVED',
              decidedBy: actor.approver,
              expiresAt: new Date(Date.now() + 60_000),
              approverActive: true,
              approverIsReviewer: true,
            },
          ],
        })
      }
      const signer = await setup({
        load: async (id) => records.get(id) ?? null,
        close: async () => {},
      })
      const a1 = await signer.sign({ actor: actor.signer, transactionId: idA })
      // Same approved transaction again: deterministic (RFC 6979), identical result.
      expect(
        (await signer.sign({ actor: actor.signer, transactionId: idA })).signedTransaction,
      ).toBe(a1.signedTransaction)
      await expect(signer.sign({ actor: actor.signer, transactionId: idB })).rejects.toMatchObject({
        code: 'CONFLICT',
      })
    })
  })

  describe.skipIf(!appUrl || !readonlyUrl)(
    'reading approvals from the application DB (read-only)',
    () => {
      let owner: pg.Client
      let source: ApprovedTransactionSource

      beforeAll(async () => {
        owner = new pg.Client({ connectionString: appUrl! })
        await owner.connect()
        source = createPgApprovedTransactionSource(readonlyUrl!)
      })
      afterAll(async () => {
        await source?.close()
        await owner?.end()
      })

      /** Inserts users, network, address, destination and a transaction approved by REVIEWER. */
      async function approvedTransaction(nonce = 5) {
        const now = new Date()
        const id = () => randomUUID()
        const user = async (role: string) => {
          const userId = id()
          await owner.query(
            `INSERT INTO users (id, email, name, password_hash, updated_at) VALUES ($1, $2, $3, 'x', now())`,
            [userId, `${userId}@test.local`, role],
          )
          await owner.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [
            userId,
            role,
          ])
          return userId
        }
        const creator = await user('ANALYST')
        const reviewer = await user('REVIEWER')
        const networkId = id()
        const chainId = randomInt(1_000_000, 2_000_000_000)
        await owner.query(
          `INSERT INTO networks (id, name, display_name, chain_id, is_testnet, updated_at)
         VALUES ($1, $2, 'Test', $3, true, now())`,
          [networkId, `sig-${networkId.slice(0, 8)}`, chainId],
        )
        const assetId = id()
        await owner.query(
          `INSERT INTO assets (id, network_id, is_native, symbol, name, decimals, updated_at)
         VALUES ($1, $2, true, 'ETH', 'Ether', 18, now())`,
          [assetId, networkId],
        )
        const addressId = id()
        await owner.query(
          `INSERT INTO addresses (id, network_id, address, owner_reference, updated_at)
         VALUES ($1, $2, $3, 'SELF', now())`,
          [addressId, networkId, TEST_ADDRESS],
        )
        const destinationId = id()
        await owner.query(
          `INSERT INTO destinations (id, network_id, address, label, updated_at)
         VALUES ($1, $2, $3, 'Cold', now())`,
          [destinationId, networkId, DEST_ADDRESS],
        )
        const u = unsignedTx(chainId, nonce)
        const txId = id()
        await owner.query(
          `INSERT INTO transactions (id, address_id, network_id, asset_id, destination_id, amount, network_fee,
            gas_limit, max_fee_per_gas, max_priority_fee_per_gas, nonce, recipient, unsigned_payload,
            unsigned_hash, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, 100000000000000000, 525000000000000, 21000, 25000000000, 1000000000,
                 $6, $7, $8, $9, $10, now())`,
          [
            txId,
            addressId,
            networkId,
            assetId,
            destinationId,
            nonce,
            DEST_ADDRESS,
            { serialized: u.serialized },
            u.hash,
            creator,
          ],
        )
        await owner.query(
          `INSERT INTO approvals (id, subject_type, transaction_id, requested_by, decided_by, decision, decided_at, expires_at)
         VALUES ($1, 'TRANSACTION', $2, $3, $4, 'APPROVED', $5, $6)`,
          [id(), txId, creator, reviewer, now, new Date(now.getTime() + 30 * 60_000)],
        )
        await owner.query(`UPDATE transactions SET status = 'APPROVED' WHERE id = $1`, [txId])
        return { txId, creator, reviewer, chainId }
      }

      it('signs a transaction that was approved in the application DB', async () => {
        const { txId, creator, reviewer } = await approvedTransaction()
        const record = await source.load(txId)
        expect(record).toMatchObject({
          status: 'APPROVED',
          createdBy: creator,
          address: TEST_ADDRESS,
        })
        expect(record?.decisions[0]).toMatchObject({
          decision: 'APPROVED',
          decidedBy: reviewer,
          approverActive: true,
          approverIsReviewer: true,
        })
        const signer = await setup(source)
        const result = await signer.sign({ actor: actor.signer, transactionId: txId })
        expect(
          await recoverTransactionAddress({ serializedTransaction: result.signedTransaction }),
        ).toBe(TEST_ADDRESS)
      })

      it('refuses once the transaction is no longer APPROVED in the DB', async () => {
        const { txId } = await approvedTransaction(6)
        await owner.query(
          `UPDATE transactions SET status = 'CANCELLED', status_reason = 'test' WHERE id = $1`,
          [txId],
        )
        const signer = await setup(source)
        await expect(
          signer.sign({ actor: actor.signer, transactionId: txId }),
        ).rejects.toMatchObject({
          code: 'CONFLICT',
        })
      })

      it('the read-only login cannot write, nor read secrets it does not need', async () => {
        const { txId } = await approvedTransaction(9)
        const ro = new pg.Client({ connectionString: readonlyUrl! })
        await ro.connect()
        try {
          await expect(
            ro.query(`UPDATE transactions SET status = 'SIGNED' WHERE id = $1`, [txId]),
          ).rejects.toThrow(/permission denied|read-only/)
          await expect(ro.query(`SELECT password_hash FROM users LIMIT 1`)).rejects.toThrow(
            /permission denied/,
          )
          await expect(ro.query(`SELECT * FROM sessions LIMIT 1`)).rejects.toThrow(
            /permission denied/,
          )
          await expect(ro.query(`SELECT signed_payload FROM transactions LIMIT 1`)).rejects.toThrow(
            /permission denied/,
          )
        } finally {
          await ro.end()
        }
      })
    },
  )
})
