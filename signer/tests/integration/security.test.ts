import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Writable } from 'node:stream'
import { keccak256, serializeTransaction } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildChallengeMessage, createLogger, signRequest } from '@da/shared'
import { buildSignerApp } from '../../src/app'
import { createKeyService } from '../../src/keys/key.service'
import type { ApprovedTransactionRecord } from '../../src/transactions/approved-source'
import { createTransactionSigner } from '../../src/transactions/sign-transaction'
import {
  createVaultDatabase,
  createVaultRepository,
  type VaultDatabase,
} from '../../src/vault/vault.repository'
import { createVaultService, type VaultService } from '../../src/vault/vault.service'

/* PUBLIC TEST VECTORS (Hardhat / Anvil) — never real funds. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const MNEMONIC = 'test test test test test test test test test test test junk'
const MNEMONIC_KEY_1 = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const MNEMONIC_ADDRESS_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const PASSPHRASE = 'marble orbit cactus lantern'
const RECOVERY = 'violet harbor tundra pencil quartz'
const SECRET = 'h'.repeat(48)

const vaultUrl = inject('testDatabaseUrl')

describe.skipIf(!vaultUrl)('signer security (Phase 13)', () => {
  let db: VaultDatabase
  let vault: VaultService
  let logLines: string[]
  let clock: number

  beforeAll(() => {
    db = createVaultDatabase(vaultUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })
  afterEach(() => vault?.shutdown())

  async function signerApp(source: ApprovedTransactionRecord | null) {
    await db.vaultKey.deleteMany({})
    await db.vaultConfig.deleteMany({})
    clock = Date.now()
    logLines = []
    const logger = createLogger({
      name: 'signer-sec',
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
    return buildSignerApp({
      logger,
      hmacSecret: SECRET,
      vault,
      keys: createKeyService({ db, repo, vault, logger, revealEnabled: true, now: () => clock }),
      transactions: createTransactionSigner({
        source: source && {
          load: async (id) => (id === source.id ? source : null),
          close: async () => {},
        },
        db,
        repo,
        vault,
        logger,
        now: () => clock,
      }),
      now: () => clock,
    })
  }

  function signed(path: string, body: object) {
    const payload = JSON.stringify(body)
    return {
      method: 'POST' as const,
      url: path,
      headers: {
        ...signRequest(SECRET, { method: 'POST', path, body: payload, timestamp: clock }),
        'content-type': 'application/json',
      },
      payload,
    }
  }

  it('no key, seed or passphrase in the vault database, logs or responses (except reveal)', async () => {
    const actor = randomUUID()
    const chainId = 11155111
    const serialized = serializeTransaction({
      type: 'eip1559',
      chainId,
      nonce: 2,
      to: MNEMONIC_ADDRESS_1,
      value: 10n ** 16n,
      gas: 21_000n,
      maxFeePerGas: 25n * 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 9n,
    })
    const txId = randomUUID()
    const app = await signerApp({
      id: txId,
      status: 'APPROVED',
      nonce: 2,
      unsignedPayload: { serialized },
      unsignedHash: keccak256(serialized),
      createdBy: randomUUID(),
      address: TEST_ADDRESS,
      chainId,
      decisions: [
        {
          decision: 'APPROVED',
          decidedBy: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
          approverActive: true,
          approverIsReviewer: true,
        },
      ],
    })
    const responses: string[] = []
    let reveal = ''
    const post = async (path: string, body: object) => {
      clock += 1 // fresh signature per request (anti-replay)
      const res = await app.inject(signed(path, body))
      if (path === '/vault/keys/reveal') reveal = res.body
      else responses.push(`${res.statusCode} ${path} ${res.body}`)
      return res
    }

    expect(
      (await post('/vault/init', { actor, passphrase: PASSPHRASE, recoveryPassphrase: RECOVERY }))
        .statusCode,
    ).toBe(200)
    await post('/vault/unlock', { actor, passphrase: `${PASSPHRASE} wrong` })
    expect((await post('/vault/unlock', { actor, passphrase: PASSPHRASE })).statusCode).toBe(200)
    expect(
      (
        await post('/vault/keys/import', {
          actor,
          expectedAddress: TEST_ADDRESS,
          secretType: 'PRIVATE_KEY',
          secret: TEST_KEY,
        })
      ).statusCode,
    ).toBe(200)
    // A key that does not match: refused, and the error must not quote it.
    await post('/vault/keys/import', {
      actor,
      expectedAddress: MNEMONIC_ADDRESS_1,
      secretType: 'PRIVATE_KEY',
      secret: TEST_KEY,
    })
    expect(
      (
        await post('/vault/keys/import', {
          actor,
          expectedAddress: MNEMONIC_ADDRESS_1,
          secretType: 'MNEMONIC',
          secret: MNEMONIC,
          derivationPath: "m/44'/60'/0'/0/1",
        })
      ).statusCode,
    ).toBe(200)
    const message = buildChallengeMessage({
      address: TEST_ADDRESS,
      networkName: 'sepolia',
      chainId,
      authorizationId: randomUUID(),
      nonce: 'a'.repeat(64),
      issuedAt: new Date(clock),
      expiresAt: new Date(clock + 600_000),
    })
    expect(
      (await post('/vault/keys/sign-challenge', { actor, address: TEST_ADDRESS, message }))
        .statusCode,
    ).toBe(200)
    expect(
      (await post('/vault/transactions/sign', { actor, transactionId: txId })).statusCode,
    ).toBe(200)
    expect(
      (await post('/vault/keys/reveal', { actor, address: TEST_ADDRESS, passphrase: PASSPHRASE }))
        .statusCode,
    ).toBe(200)
    expect(reveal).toContain(TEST_KEY)

    const dump: string[] = []
    for (const table of ['vault_config', 'vault_keys', 'vault_events']) {
      const rows = await db.$queryRawUnsafe<Array<{ row: string }>>(
        `SELECT row_to_json(t)::text AS row FROM "${table}" t`,
      )
      dump.push(...rows.map((r) => `${table}: ${r.row}`))
    }
    const needles: Array<[string, string]> = [
      ['private key', TEST_KEY.slice(2)],
      ['seed-derived key', MNEMONIC_KEY_1],
      ['seed phrase', MNEMONIC],
      ['vault passphrase', PASSPHRASE],
      ['recovery passphrase', RECOVERY],
      ['HMAC secret', SECRET],
    ]
    const places: Array<[string, string]> = [
      ['vault database', dump.join('\n')],
      ['logs', logLines.join('')],
      ['responses (except reveal)', responses.join('\n')],
    ]
    const leaks = places.flatMap(([where, text]) =>
      needles.filter(([, s]) => text.includes(s)).map(([what]) => `${what} in ${where}`),
    )
    expect(leaks).toEqual([])
    expect(dump.length).toBeGreaterThan(5)
    await app.close()
  })

  it('is not reachable from other network interfaces (binds to loopback only)', async () => {
    const app = await signerApp(null)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = (app.server.address() as { port: number }).port
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && !i.internal && i.family === 'IPv4')
      .map((i) => i!.address)
    const attempt = (host: string) =>
      new Promise<'connected' | 'refused'>((resolve) => {
        const socket = connect({ host, port, timeout: 1500 })
        socket.once('connect', () => {
          socket.destroy()
          resolve('connected')
        })
        socket.once('error', () => resolve('refused'))
        socket.once('timeout', () => {
          socket.destroy()
          resolve('refused')
        })
      })
    expect(await attempt('127.0.0.1')).toBe('connected')
    for (const host of external) expect(`${host}: ${await attempt(host)}`).toBe(`${host}: refused`)
    await app.close()
  })
})
