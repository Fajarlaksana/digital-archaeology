import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { Prisma } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, PASSWORD, type Harness } from '../auth/harness'
import { NO_ACTIVITY } from '../fake-chain'

/* PUBLIC TEST VECTORS (Hardhat / Anvil) — never real funds. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const MNEMONIC = 'test test test test test test test test test test test junk'
const MNEMONIC_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // index 1
const DEST_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const PASSPHRASE = 'marble orbit cactus lantern'
const RECOVERY = 'violet harbor tundra pencil quartz'
const ETH = 10n ** 18n

const testDatabaseUrl = inject('testDatabaseUrl')

/**
 * "No secret leakage" (Phase 13, SA 17): run the whole key lifecycle through the API, then look
 * for every secret in every log line, every API response (except the break-glass reveal) and a
 * dump of every table of the application database.
 */
describe.skipIf(!testDatabaseUrl)('no secret leakage', () => {
  let db: Database
  let h: Harness

  beforeAll(() => {
    db = createPrismaClient(testDatabaseUrl!)
  })
  afterAll(async () => {
    await db?.$disconnect()
  })
  afterEach(async () => {
    await h?.app.close()
  })

  it('keys, seed, passphrases, passwords and TOTP secrets appear nowhere they must not', async () => {
    h = await createHarness(db)
    const responses: string[] = []
    let revealResponse = ''
    const call = async (method: 'GET' | 'POST', url: string, token: string, body?: object) => {
      const res = await h.call(method, url, token, body)
      if (url === '/api/vault/keys/reveal') revealResponse = res.body
      else responses.push(`${res.statusCode} ${url} ${JSON.stringify(res.headers)} ${res.body}`)
      return res
    }

    const network = await db.network.create({
      data: {
        name: `leak-${randomUUID().slice(0, 8)}`,
        displayName: 'Leak net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: true,
        assets: { create: [{ isNative: true, symbol: 'ETH', name: 'Ether', decimals: 18 }] },
      },
      include: { assets: true },
    })
    h.chain.restrictTo([network.id])
    const users = {
      superAdmin: await h.createUser(['SUPER_ADMIN'], { mfa: true }),
      analyst: await h.createUser(['ANALYST']),
      reviewer: await h.createUser(['REVIEWER'], { mfa: true }),
    }
    const token = {
      superAdmin: await h.activeSession(users.superAdmin),
      analyst: await h.activeSession(users.analyst),
      reviewer: await h.activeSession(users.reviewer),
    }

    // Inventory: one address for a raw key, one for a seed-derived key.
    const address = (
      await call('POST', '/api/addresses', token.analyst, {
        networkId: network.id,
        address: TEST_ADDRESS,
        ownerReference: 'SELF',
      })
    ).json().address
    const seeded = (
      await call('POST', '/api/addresses', token.analyst, {
        networkId: network.id,
        address: MNEMONIC_ADDRESS,
        ownerReference: 'SELF',
      })
    ).json().address

    // Vault lifecycle with both secret types, plus a break-glass reveal.
    expect(
      (
        await call('POST', '/api/vault/init', token.superAdmin, {
          passphrase: PASSPHRASE,
          recoveryPassphrase: RECOVERY,
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (await call('POST', '/api/vault/unlock', token.superAdmin, { passphrase: PASSPHRASE }))
        .statusCode,
    ).toBe(200)
    expect(
      (
        await call('POST', '/api/vault/keys', token.superAdmin, {
          addressId: address.id,
          secretType: 'PRIVATE_KEY',
          secret: TEST_KEY,
        })
      ).statusCode,
    ).toBe(201)
    expect(
      (
        await call('POST', '/api/vault/keys', token.superAdmin, {
          addressId: seeded.id,
          secretType: 'MNEMONIC',
          secret: MNEMONIC,
          derivationPath: "m/44'/60'/0'/0/1",
        })
      ).statusCode,
    ).toBe(201)
    // A fresh TOTP step for the reveal (the login consumed the current one: no replay).
    h.advance(31_000)
    // Wrong passphrase on purpose: errors must not echo it either.
    await call('POST', '/api/vault/unlock', token.superAdmin, { passphrase: `${PASSPHRASE} wrong` })
    expect(
      (
        await call('POST', '/api/vault/keys/reveal', token.superAdmin, {
          addressId: address.id,
          passphrase: PASSPHRASE,
          code: h.code(users.superAdmin.secret!),
        })
      ).statusCode,
    ).toBe(200)
    expect(revealResponse).toContain(TEST_KEY) // the one place a key may appear

    // Ownership: authorization + challenge signed by the vault.
    const authorization = (
      await call('POST', `/api/addresses/${address.id}/authorizations`, token.analyst, {
        type: 'SELF',
        reference: 'Own wallet',
      })
    ).json().authorization
    const challenge = (
      await call('POST', `/api/authorizations/${authorization.id}/challenges`, token.superAdmin, {})
    ).json().challenge
    expect(
      (await call('POST', `/api/challenges/${challenge.id}/vault-signature`, token.superAdmin, {}))
        .statusCode,
    ).toBe(200)

    // Transaction: preview → approve → sign → broadcast (three different people + fake chain).
    const destination = await db.destination.create({
      data: {
        networkId: network.id,
        address: DEST_ADDRESS,
        label: 'Cold',
        status: 'APPROVED',
        controlVerifiedAt: new Date(),
        controlVerifiedById: users.analyst.id,
        createdById: users.analyst.id,
        approvals: {
          create: {
            subjectType: 'DESTINATION',
            requestedById: users.analyst.id,
            decidedById: users.reviewer.id,
            decision: 'APPROVED',
            decidedAt: new Date(),
          },
        },
      },
    })
    await db.priceSnapshot.create({
      data: {
        assetId: network.assets[0]!.id,
        fiatCurrency: 'USD',
        price: new Prisma.Decimal('2000'),
        source: 'test',
        pricedAt: new Date(),
      },
    })
    h.chain.set(TEST_ADDRESS, { nonce: 1, native: ETH, activity: NO_ACTIVITY })
    const tx = (
      await call('POST', '/api/transactions/preview', token.analyst, {
        addressId: address.id,
        assetId: network.assets[0]!.id,
        destinationId: destination.id,
      })
    ).json().transaction
    expect(
      (
        await call('POST', `/api/transactions/${tx.id}/approve`, token.reviewer, {
          reason: 'Checked',
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (await call('POST', `/api/transactions/${tx.id}/sign`, token.superAdmin, {})).statusCode,
    ).toBe(200)
    expect(
      (await call('POST', `/api/transactions/${tx.id}/broadcast`, token.superAdmin, {})).statusCode,
    ).toBe(200)
    await call('GET', `/api/transactions/${tx.id}`, token.analyst)
    await call('POST', '/api/auth/reauth', token.analyst, { password: PASSWORD })

    // Every table of the application database, row by row.
    const tables = await db.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    const dump: string[] = []
    for (const { table_name } of tables) {
      const rows = await db.$queryRawUnsafe<Array<{ row: string }>>(
        `SELECT row_to_json(t)::text AS row FROM "${table_name}" t`,
      )
      dump.push(...rows.map((r) => `${table_name}: ${r.row}`))
    }
    expect(tables.length).toBeGreaterThan(15)

    const keyHex = TEST_KEY.slice(2)
    const needles: Array<[string, string]> = [
      ['private key', keyHex],
      ['private key (upper case)', keyHex.toUpperCase()],
      ['seed phrase', MNEMONIC],
      ['vault passphrase', PASSPHRASE],
      ['recovery passphrase', RECOVERY],
      ['login password', PASSWORD],
      ['TOTP secret (SUPER_ADMIN)', users.superAdmin.secret!],
      ['TOTP secret (REVIEWER)', users.reviewer.secret!],
    ]
    const places: Array<[string, string]> = [
      ['logs', h.logs()],
      ['API responses (except reveal)', responses.join('\n')],
      ['application database dump', dump.join('\n')],
    ]
    const leaks = places.flatMap(([where, text]) =>
      needles.filter(([, secret]) => text.includes(secret)).map(([what]) => `${what} in ${where}`),
    )
    expect(leaks).toEqual([])
    expect(responses.length).toBeGreaterThan(15)
  })
})
