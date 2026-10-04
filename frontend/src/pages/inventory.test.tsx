import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type { PublicAddress, PublicNetwork } from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const ANALYST: Permission[] = ['networks:read', 'addresses:read', 'addresses:manage', 'scans:read']
const AUDITOR: Permission[] = ['networks:read', 'addresses:read', 'audit:read']
const ADMIN: Permission[] = ['networks:read', 'networks:manage', 'addresses:read', 'users:read']

const SEPOLIA: PublicNetwork = {
  id: 'net-1',
  name: 'sepolia',
  displayName: 'Ethereum Sepolia (testnet)',
  chainType: 'EVM',
  chainId: 11155111,
  isTestnet: true,
  rpcUrlEnv: 'SEPOLIA_RPC_URL',
  rpcConfigured: false,
  explorerUrl: 'https://sepolia.etherscan.io',
  status: 'ACTIVE',
  assets: [
    {
      id: 'a1',
      symbol: 'ETH',
      name: 'Sepolia Ether',
      decimals: 18,
      isNative: true,
      contractAddress: null,
      priceId: 'ethereum',
    },
    {
      id: 'a2',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      isNative: false,
      contractAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      priceId: 'usd-coin',
    },
  ],
}

const ADDRESS: PublicAddress = {
  id: '11111111-1111-4111-8111-111111111111',
  network: { id: 'net-1', name: 'sepolia', displayName: SEPOLIA.displayName },
  address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  label: 'Wallet 2019',
  ownerReference: 'SELF',
  activityStatus: 'UNKNOWN',
  balanceStatus: 'UNKNOWN',
  authorizationStatus: 'UNVERIFIED',
  recoveryStatus: 'NONE',
  recoveryReasons: [],
  eligibilityCheckedAt: null,
  reviewFlag: false,
  lastActivityAt: null,
  inactiveDays: null,
  lastScannedAt: null,
  archivedAt: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  explorerUrl: 'https://sepolia.etherscan.io/address/0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  estimatedValue: '1250.25000000',
  fiatCurrency: 'USD',
  valueSimulated: true,
}

const page = (items: PublicAddress[]) =>
  json(200, { items, total: items.length, page: 1, pageSize: 50 })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Networks page', () => {
  it('shows networks, assets and an RPC warning without exposing URLs', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('ADMIN', ADMIN)),
      'GET /api/networks': () => json(200, { networks: [SEPOLIA] }),
    })
    renderAt('/networks')
    const card = await screen.findByRole('article', { name: SEPOLIA.displayName })
    expect(within(card).getByText('Testnet')).toBeTruthy()
    expect(within(card).getByText(/belum ada di env server/)).toBeTruthy()
    expect(within(card).getByText(SEPOLIA.assets[1]!.contractAddress!)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tambah network' })).toBeTruthy()
  })

  it('hides management controls without networks:manage', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ANALYST)),
      'GET /api/networks': () => json(200, { networks: [SEPOLIA] }),
    })
    renderAt('/networks')
    await screen.findByRole('article', { name: SEPOLIA.displayName })
    expect(screen.queryByRole('button', { name: 'Tambah network' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Nonaktifkan' })).toBeNull()
  })
})

describe('Addresses page', () => {
  it('lists addresses and offers create/import to an ANALYST', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ANALYST)),
      'GET /api/networks': () => json(200, { networks: [SEPOLIA] }),
      'GET /api/addresses*': () => page([ADDRESS]),
    })
    renderAt('/addresses')
    expect(await screen.findByText('Wallet 2019')).toBeTruthy()
    expect(screen.getByRole('link', { name: /0x5aAeb6/ }).getAttribute('href')).toBe(
      `/addresses/${ADDRESS.id}`,
    )
    expect(screen.getByRole('button', { name: 'Tambah address' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Import CSV' })).toBeTruthy()
  })

  it('is read-only for an AUDITOR', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('AUDITOR', AUDITOR)),
      'GET /api/networks': () => json(200, { networks: [SEPOLIA] }),
      'GET /api/addresses*': () => page([ADDRESS]),
    })
    renderAt('/addresses')
    await screen.findByText('Wallet 2019')
    expect(screen.queryByRole('button', { name: 'Tambah address' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Import CSV' })).toBeNull()
  })

  it('shows the server error when creating an address fails', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ANALYST)),
      'GET /api/networks': () => json(200, { networks: [SEPOLIA] }),
      'GET /api/addresses*': () => page([]),
      'POST /api/addresses': () =>
        json(400, {
          error: {
            code: 'INVALID_ADDRESS',
            message:
              'Checksum (upper/lower case) does not match — the address is probably mistyped',
            request_id: 'r1',
          },
        }),
    })
    renderAt('/addresses')
    fireEvent.click(await screen.findByRole('button', { name: 'Tambah address' }))
    const form = screen.getByRole('form', { name: 'Tambah address' })
    fireEvent.change(within(form).getByLabelText('Address'), {
      target: { value: '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' },
    })
    fireEvent.change(within(form).getByLabelText(/Owner reference/), { target: { value: 'SELF' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Simpan' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/probably mistyped/)
  })
})

describe('CSV import', () => {
  it('previews first, then saves only after confirmation', async () => {
    const fetchMock = mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ANALYST)),
      'GET /api/networks': () => json(200, { networks: [SEPOLIA] }),
      'GET /api/addresses*': () => page([]),
      'POST /api/addresses/import/preview': () =>
        json(200, {
          summary: { total: 2, valid: 1, rejected: 1, byReason: { UNKNOWN_NETWORK: 1 } },
          results: [
            {
              line: 2,
              status: 'VALID',
              input: {
                address: ADDRESS.address,
                network: 'sepolia',
                label: '',
                ownerReference: 'SELF',
              },
              address: ADDRESS.address,
            },
            {
              line: 3,
              status: 'REJECTED',
              input: { address: '0xabc', network: 'mainnet', label: '', ownerReference: 'SELF' },
              reason: 'UNKNOWN_NETWORK',
              message: 'Network "mainnet" is not registered',
            },
          ],
        }),
      'POST /api/addresses/import': () =>
        json(200, {
          created: 1,
          summary: { total: 2, valid: 1, rejected: 1, byReason: {} },
          results: [],
        }),
    })
    renderAt('/addresses')
    fireEvent.click(await screen.findByRole('button', { name: 'Import CSV' }))

    const csv = `address,network,owner_reference\n${ADDRESS.address},sepolia,SELF\n0xabc,mainnet,SELF\n`
    const file = new File([csv], 'wallets.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('File CSV'), { target: { files: [file] } })
    const check = await screen.findByRole('button', { name: /Periksa wallets\.csv/ })
    fireEvent.click(check)

    expect(await screen.findByText('Network "mainnet" is not registered')).toBeTruthy()
    expect(screen.getByText('Network tidak dikenal: 1')).toBeTruthy()
    const commitCalls = () =>
      fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/addresses/import' && init?.method === 'POST',
      )
    expect(commitCalls()).toHaveLength(0) // nothing saved yet

    fireEvent.click(screen.getByRole('button', { name: 'Simpan 1 baris valid' }))
    await waitFor(() => expect(screen.getByText(/1 address tersimpan/)).toBeTruthy())
    expect(commitCalls()).toHaveLength(1)
    expect(JSON.parse(String(commitCalls()[0]![1]!.body)).csv).toBe(csv)
  })
})

describe('Address detail', () => {
  it('shows ownership and statuses, and links to the explorer', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ANALYST)),
      [`GET /api/addresses/${ADDRESS.id}`]: () => json(200, { address: ADDRESS }),
      [`GET /api/addresses/${ADDRESS.id}/balances`]: () => json(200, { balances: [] }),
      [`GET /api/addresses/${ADDRESS.id}/activity`]: () => json(200, { history: [] }),
      [`GET /api/addresses/${ADDRESS.id}/authorizations`]: () => json(200, { authorizations: [] }),
      [`GET /api/addresses/${ADDRESS.id}/eligibility`]: () => json(200, { assets: [] }),
    })
    renderAt(`/addresses/${ADDRESS.id}`)
    expect(await screen.findByRole('heading', { name: ADDRESS.address })).toBeTruthy()
    expect(screen.getByText('SELF')).toBeTruthy()
    expect(screen.getByRole('link', { name: /explorer/ }).getAttribute('href')).toBe(
      ADDRESS.explorerUrl,
    )
    expect(screen.getByRole('button', { name: 'Arsipkan' })).toBeTruthy()
  })
})
