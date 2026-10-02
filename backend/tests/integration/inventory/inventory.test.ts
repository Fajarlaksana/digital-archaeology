import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { getAddress } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Role } from '../../../src/generated/prisma/client'
import { createPrismaClient, type Database } from '../../../src/lib/prisma'
import { createHarness, type Harness } from '../auth/harness'

const testDatabaseUrl = inject('testDatabaseUrl')
const MFA_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'REVIEWER'])

const randomAddress = () => getAddress(`0x${randomBytes(20).toString('hex')}`)
/** Flips the case of the first letter: a checksum error a human typo would produce. */
function badChecksum(address: string): string {
  const i = address.slice(2).search(/[a-fA-F]/) + 2
  const ch = address[i]!
  return (
    address.slice(0, i) +
    (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) +
    address.slice(i + 1)
  )
}

describe.skipIf(!testDatabaseUrl)('networks & address inventory', () => {
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

  async function tokenFor(role: Role) {
    const user = await h.createUser([role], { mfa: MFA_ROLES.has(role) })
    return { user, token: await h.activeSession(user) }
  }

  /** A fresh, active testnet network with a native asset (unique per test). */
  async function makeNetwork(overrides: { status?: 'ACTIVE' | 'DISABLED' } = {}) {
    return db.network.create({
      data: {
        name: `net-${randomUUID().slice(0, 8)}`,
        displayName: 'Test net',
        chainId: randomInt(1_000_000, 2_000_000_000),
        isTestnet: true,
        explorerUrl: 'https://explorer.test',
        status: overrides.status ?? 'ACTIVE',
        assets: { create: [{ isNative: true, symbol: 'TST', name: 'Test', decimals: 18 }] },
      },
    })
  }

  const networkBody = (overrides: Record<string, unknown> = {}) => ({
    name: `net-${randomUUID().slice(0, 8)}`,
    displayName: 'Holesky',
    chainType: 'EVM',
    chainId: randomInt(1_000_000, 2_000_000_000),
    isTestnet: true,
    rpcUrlEnv: 'CONFIGURED_RPC_URL',
    explorerUrl: 'https://holesky.etherscan.io',
    nativeAsset: { symbol: 'ETH', name: 'Holesky Ether', decimals: 18 },
    ...overrides,
  })

  describe('networks', () => {
    it.each([
      ['SUPER_ADMIN', 200, 403],
      ['ADMIN', 200, 201],
      ['ANALYST', 200, 403],
      ['REVIEWER', 200, 403],
      ['AUDITOR', 200, 403],
    ] as const)('%s → list %i, create %i', async (role, list, create) => {
      h = await createHarness(db)
      const { token } = await tokenFor(role)
      expect((await h.call('GET', '/api/networks', token)).statusCode).toBe(list)
      expect((await h.call('POST', '/api/networks', token, networkBody())).statusCode).toBe(create)
    })

    it('creates a network with its native asset and reports RPC config without exposing it', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      const res = await h.call('POST', '/api/networks', token, networkBody())
      expect(res.statusCode).toBe(201)
      expect(res.json().network).toMatchObject({
        rpcUrlEnv: 'CONFIGURED_RPC_URL',
        rpcConfigured: true,
        status: 'ACTIVE',
        assets: [{ symbol: 'ETH', isNative: true, decimals: 18, contractAddress: null }],
      })
      const other = await h.call(
        'POST',
        '/api/networks',
        token,
        networkBody({ rpcUrlEnv: 'MISSING_RPC_URL' }),
      )
      expect(other.json().network.rpcConfigured).toBe(false)
    })

    it('refuses a URL in rpcUrlEnv (URLs often embed API keys)', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      const res = await h.call(
        'POST',
        '/api/networks',
        token,
        networkBody({ rpcUrlEnv: 'https://rpc.example/key123' }),
      )
      expect(res.statusCode).toBe(400)
    })

    it('rejects mainnet networks while NETWORK_MODE=testnet (rule 10)', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      const res = await h.call('POST', '/api/networks', token, networkBody({ isTestnet: false }))
      expect(res.statusCode).toBe(403)
      expect(res.json().error.message).toMatch(/NETWORK_MODE=testnet/)
    })

    it('allows mainnet networks only when NETWORK_MODE=mainnet', async () => {
      h = await createHarness(db, { networkMode: 'mainnet' })
      const { token } = await tokenFor('ADMIN')
      const res = await h.call('POST', '/api/networks', token, networkBody({ isTestnet: false }))
      expect(res.statusCode).toBe(201)
    })

    it('rejects duplicate names and chain ids', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      const body = networkBody()
      await h.call('POST', '/api/networks', token, body)
      expect(
        (await h.call('POST', '/api/networks', token, { ...body, chainId: body.chainId + 1 }))
          .statusCode,
      ).toBe(409)
      expect(
        (await h.call('POST', '/api/networks', token, { ...networkBody(), chainId: body.chainId }))
          .statusCode,
      ).toBe(409)
    })

    it('rejects unsupported chain types for now', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      const res = await h.call(
        'POST',
        '/api/networks',
        token,
        networkBody({ chainType: 'BITCOIN', chainId: null }),
      )
      expect(res.json().error.code).toBe('INVALID_NETWORK')
    })

    it('adds an ERC-20 token with checksum validation and no duplicates', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      const network = await makeNetwork()
      const contract = randomAddress()
      const url = `/api/networks/${network.id}/assets`
      const tokenBody = {
        contractAddress: contract.toLowerCase(),
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
      }

      const bad = await h.call('POST', url, token, {
        ...tokenBody,
        contractAddress: badChecksum(contract),
      })
      expect(bad.json().error.code).toBe('INVALID_ADDRESS')

      const ok = await h.call('POST', url, token, tokenBody)
      expect(ok.statusCode).toBe(201)
      expect(ok.json().asset).toMatchObject({
        contractAddress: contract,
        isNative: false,
        decimals: 6,
      })

      expect((await h.call('POST', url, token, tokenBody)).statusCode).toBe(409)
      expect((await h.call('POST', url, token, { ...tokenBody, decimals: 37 })).statusCode).toBe(
        400,
      )
    })

    it('disables a network and keeps it immutable where it matters', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      const network = await makeNetwork()
      const res = await h.call('PATCH', `/api/networks/${network.id}`, token, {
        status: 'DISABLED',
      })
      expect(res.json().network.status).toBe('DISABLED')
      // isTestnet / chainId are not editable: flipping a network to mainnet must not be possible.
      const flip = await h.call('PATCH', `/api/networks/${network.id}`, token, { isTestnet: false })
      expect(flip.statusCode).toBe(400)
    })
  })

  describe('addresses', () => {
    it.each([
      ['SUPER_ADMIN', 200, 403],
      ['ADMIN', 200, 403],
      ['ANALYST', 200, 201],
      ['REVIEWER', 200, 403],
      ['AUDITOR', 200, 403],
    ] as const)('%s → list %i, create %i', async (role, list, create) => {
      h = await createHarness(db)
      const { token } = await tokenFor(role)
      const network = await makeNetwork()
      expect((await h.call('GET', '/api/addresses', token)).statusCode).toBe(list)
      const body = { networkId: network.id, address: randomAddress(), ownerReference: 'SELF' }
      expect((await h.call('POST', '/api/addresses', token, body)).statusCode).toBe(create)
    })

    it('stores the checksummed form and audits the creation', async () => {
      h = await createHarness(db)
      const { user, token } = await tokenFor('ANALYST')
      const network = await makeNetwork()
      const address = randomAddress()
      const res = await h.call('POST', '/api/addresses', token, {
        networkId: network.id,
        address: address.toLowerCase(),
        label: 'Wallet 2019',
        ownerReference: 'SELF',
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().address).toMatchObject({
        address,
        label: 'Wallet 2019',
        ownerReference: 'SELF',
        activityStatus: 'UNKNOWN',
        explorerUrl: `https://explorer.test/address/${address}`,
      })
      const audit = await db.auditLog.findFirst({
        where: { userId: user.id, action: 'ADDRESS_CREATED' },
      })
      expect(audit?.resourceId).toBe(res.json().address.id)
    })

    it.each([
      ['a bad checksum', (a: string) => ({ address: badChecksum(a) }), 'INVALID_ADDRESS'],
      ['a blank owner reference', () => ({ ownerReference: '  ' }), 'VALIDATION_ERROR'],
      ['a missing owner reference', () => ({ ownerReference: undefined }), 'VALIDATION_ERROR'],
    ])('rejects %s', async (_label, override, code) => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const network = await makeNetwork()
      const address = randomAddress()
      const res = await h.call('POST', '/api/addresses', token, {
        networkId: network.id,
        address,
        ownerReference: 'SELF',
        ...override(address),
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe(code)
    })

    it('rejects addresses on a disabled network and duplicates', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const off = await makeNetwork({ status: 'DISABLED' })
      const onDisabled = await h.call('POST', '/api/addresses', token, {
        networkId: off.id,
        address: randomAddress(),
        ownerReference: 'SELF',
      })
      expect(onDisabled.json().error.code).toBe('INVALID_NETWORK')

      const network = await makeNetwork()
      const body = { networkId: network.id, address: randomAddress(), ownerReference: 'SELF' }
      await h.call('POST', '/api/addresses', token, body)
      const dup = await h.call('POST', '/api/addresses', token, {
        ...body,
        address: body.address.toLowerCase(),
      })
      expect(dup.statusCode).toBe(409)
    })

    it('records owner_reference changes with before/after', async () => {
      h = await createHarness(db)
      const { user, token } = await tokenFor('ANALYST')
      const network = await makeNetwork()
      const created = await h.call('POST', '/api/addresses', token, {
        networkId: network.id,
        address: randomAddress(),
        ownerReference: 'SELF',
      })
      const id = created.json().address.id
      const res = await h.call('PATCH', `/api/addresses/${id}`, token, {
        ownerReference: 'CASE-2026-001',
      })
      expect(res.json().address.ownerReference).toBe('CASE-2026-001')

      const audit = await db.auditLog.findFirst({
        where: { userId: user.id, action: 'ADDRESS_UPDATED', resourceId: id },
      })
      expect(audit?.metadata).toMatchObject({
        before: { ownerReference: 'SELF' },
        after: { ownerReference: 'CASE-2026-001' },
      })
    })

    it('archives (hidden, read-only, history kept) and restores', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const network = await makeNetwork()
      const address = randomAddress()
      const created = await h.call('POST', '/api/addresses', token, {
        networkId: network.id,
        address,
        label: 'to-archive',
        ownerReference: 'SELF',
      })
      const id = created.json().address.id
      const list = (q: string) =>
        h.call('GET', `/api/addresses?networkId=${network.id}${q}`, token).then((r) => r.json())

      const archived = await h.call('POST', `/api/addresses/${id}/archive`, token, {
        reason: 'wallet emptied',
      })
      expect(archived.json().address.archivedAt).not.toBeNull()
      expect((await list('')).total).toBe(0)
      expect((await list('&archived=only')).total).toBe(1)
      expect(
        (await h.call('PATCH', `/api/addresses/${id}`, token, { label: 'x' })).statusCode,
      ).toBe(409)

      const again = await h.call('POST', '/api/addresses', token, {
        networkId: network.id,
        address,
        ownerReference: 'SELF',
      })
      expect(again.statusCode).toBe(409)
      expect(again.json().error.message).toMatch(/restore it/)

      expect((await h.call('POST', `/api/addresses/${id}/restore`, token, {})).statusCode).toBe(200)
      expect((await list('')).total).toBe(1)
    })

    it('searches by label, address and owner reference, with pagination', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const network = await makeNetwork()
      for (let i = 0; i < 3; i++) {
        await h.call('POST', '/api/addresses', token, {
          networkId: network.id,
          address: randomAddress(),
          label: i === 0 ? 'Ledger lama' : `other ${i}`,
          ownerReference: i === 2 ? 'CASE-77' : 'SELF',
        })
      }
      const get = (q: string) =>
        h.call('GET', `/api/addresses?networkId=${network.id}&${q}`, token).then((r) => r.json())
      expect((await get('search=ledger')).total).toBe(1)
      expect((await get('search=case-77')).total).toBe(1)
      const page = await get('pageSize=2&page=2')
      expect(page).toMatchObject({ total: 3, page: 2, pageSize: 2 })
      expect(page.items).toHaveLength(1)
    })
  })

  describe('CSV import', () => {
    it('previews 100 mixed rows without saving, then commits only the valid ones', async () => {
      h = await createHarness(db)
      const { user, token } = await tokenFor('ANALYST')
      const network = await makeNetwork()
      const existing = Array.from({ length: 5 }, randomAddress)
      for (const address of existing) {
        await db.address.create({
          data: { networkId: network.id, address, ownerReference: 'SELF' },
        })
      }

      const valid = Array.from({ length: 70 }, randomAddress)
      const lines = [
        ...valid.map((a, i) => `${a.toLowerCase()},${network.name},Wallet ${i},SELF`),
        ...Array.from(
          { length: 10 },
          () => `${badChecksum(randomAddress())},${network.name},,SELF`,
        ),
        ...Array.from({ length: 5 }, () => `${randomAddress()},no-such-network,,SELF`),
        ...Array.from({ length: 5 }, () => `${randomAddress()},${network.name},,`),
        ...valid.slice(0, 5).map((a) => `${a},${network.name},dup,SELF`),
        ...existing.map((a) => `${a},${network.name},,SELF`),
      ]
      expect(lines).toHaveLength(100)
      const csv = `address,network,label,owner_reference\n${lines.join('\n')}\n`
      const count = () => db.address.count({ where: { networkId: network.id } })

      const preview = await h.call('POST', '/api/addresses/import/preview', token, { csv })
      expect(preview.statusCode).toBe(200)
      expect(preview.json().summary).toEqual({
        total: 100,
        valid: 70,
        rejected: 30,
        byReason: {
          BAD_CHECKSUM: 10,
          UNKNOWN_NETWORK: 5,
          MISSING_OWNER_REFERENCE: 5,
          DUPLICATE_IN_FILE: 5,
          ALREADY_EXISTS: 5,
        },
      })
      expect(preview.json().results.find((r: { line: number }) => r.line === 82)).toMatchObject({
        status: 'REJECTED',
        reason: 'UNKNOWN_NETWORK',
      })
      expect(await count()).toBe(5) // preview saved nothing

      const commit = await h.call('POST', '/api/addresses/import', token, { csv })
      expect(commit.json()).toMatchObject({ created: 70, summary: { valid: 70, rejected: 30 } })
      expect(await count()).toBe(75)
      const stored = await db.address.findFirst({
        where: { networkId: network.id, label: 'Wallet 0' },
      })
      expect(stored?.address).toBe(valid[0]) // checksummed form

      const audit = await db.auditLog.findFirst({
        where: { userId: user.id, action: 'ADDRESSES_IMPORTED' },
      })
      expect(audit?.resourceId).toMatch(/^[0-9a-f]{64}$/)
      expect(audit?.metadata).toMatchObject({ created: 70, total: 100 })

      // Re-importing the same file creates nothing.
      const again = await h.call('POST', '/api/addresses/import', token, { csv })
      expect(again.json()).toMatchObject({ created: 0, summary: { valid: 0 } })
      expect(again.json().summary.byReason.ALREADY_EXISTS).toBe(75)
    })

    it('rejects structurally broken files as a whole', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ANALYST')
      const res = await h.call('POST', '/api/addresses/import/preview', token, {
        csv: `address,network\n${randomAddress()},sepolia\n`,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.message).toMatch(/owner_reference/)
    })

    it('is not available to roles without addresses:manage', async () => {
      h = await createHarness(db)
      const { token } = await tokenFor('ADMIN')
      const res = await h.call('POST', '/api/addresses/import/preview', token, {
        csv: `address,network,owner_reference\n${randomAddress()},sepolia,SELF\n`,
      })
      expect(res.statusCode).toBe(403)
    })
  })
})
