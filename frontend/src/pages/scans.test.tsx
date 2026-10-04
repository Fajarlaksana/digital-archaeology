import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type { PublicNetwork, PublicScan, ScanResultItem } from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const ANALYST: Permission[] = [
  'networks:read',
  'addresses:read',
  'addresses:manage',
  'scans:read',
  'scans:run',
]
const AUDITOR: Permission[] = ['networks:read', 'addresses:read', 'scans:read', 'audit:read']

const NETWORK: PublicNetwork = {
  id: 'net-1',
  name: 'sepolia',
  displayName: 'Ethereum Sepolia (testnet)',
  chainType: 'EVM',
  chainId: 11155111,
  isTestnet: true,
  rpcUrlEnv: 'SEPOLIA_RPC_URL',
  rpcConfigured: true,
  explorerUrl: null,
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
  ],
}

function scan(overrides: Partial<PublicScan> = {}): PublicScan {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    network: {
      id: 'net-1',
      name: 'sepolia',
      displayName: NETWORK.displayName,
      nativeSymbol: 'ETH',
    },
    status: 'COMPLETED',
    trigger: 'MANUAL',
    thresholdDays: 730,
    minimumBalance: '0.1',
    maximumBalance: null,
    totalAddresses: 3,
    processedAddresses: 3,
    totalInactive: 1,
    totalFailed: 1,
    errorMessage: null,
    createdAt: '2026-10-02T08:00:00.000Z',
    startedAt: '2026-10-02T08:00:01.000Z',
    completedAt: '2026-10-02T08:00:09.000Z',
    ...overrides,
  }
}

const RESULT: ScanResultItem = {
  addressId: '11111111-1111-4111-8111-111111111111',
  address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  label: 'Wallet 2019',
  activityStatus: 'INACTIVE',
  balanceStatus: 'HAS_BALANCE',
  inactiveDays: 1148,
  lastActivityAt: '2026-09-29T00:00:00.000Z',
  lastOutgoingAt: '2023-08-10T00:00:00.000Z',
  incomingTxCount: 5,
  outgoingTxCount: 2,
  nonce: 2,
  reviewFlag: false,
  errorCode: null,
  nativeBalance: '0.5',
  matchesCriteria: true,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Scans page', () => {
  it('lets an ANALYST start a scan and opens its detail page', async () => {
    const fetchMock = mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ANALYST)),
      'GET /api/networks': () => json(200, { networks: [NETWORK] }),
      'GET /api/scans*': () => json(200, { items: [], total: 0, page: 1, pageSize: 20 }),
      'POST /api/scans': () =>
        json(202, { scan: scan({ status: 'QUEUED', processedAddresses: 0 }) }),
      [`GET /api/scans/${scan().id}`]: () =>
        json(200, { scan: scan({ status: 'QUEUED', processedAddresses: 0 }) }),
      [`GET /api/scans/${scan().id}/results*`]: () =>
        json(200, { items: [], total: 0, page: 1, pageSize: 50 }),
    })
    renderAt('/scans')
    const form = await screen.findByRole('form', { name: 'Scan baru' })
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: NETWORK.displayName })).toBeTruthy(),
    )
    fireEvent.change(within(form).getByLabelText('Saldo minimum ETH'), { target: { value: '0.1' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Mulai scan' }))

    expect(await screen.findByRole('heading', { name: /Scan Ethereum Sepolia/ })).toBeTruthy()
    const post = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/scans' && init?.method === 'POST',
    )
    expect(JSON.parse(String(post![1]!.body))).toEqual({
      networkId: 'net-1',
      thresholdDays: 730,
      minimumBalance: '0.1',
      maximumBalance: null,
    })
  })

  it('is read-only for an AUDITOR', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('AUDITOR', AUDITOR)),
      'GET /api/scans*': () => json(200, { items: [scan()], total: 1, page: 1, pageSize: 20 }),
    })
    renderAt('/scans')
    expect(await screen.findByText('COMPLETED')).toBeTruthy()
    expect(screen.queryByRole('form', { name: 'Scan baru' })).toBeNull()
  })
})

describe('Scan detail page', () => {
  it('shows totals, results with badges, and filters by tab', async () => {
    const fetchMock = mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ANALYST)),
      [`GET /api/scans/${scan().id}`]: () => json(200, { scan: scan() }),
      [`GET /api/scans/${scan().id}/results*`]: () =>
        json(200, {
          items: [
            RESULT,
            {
              ...RESULT,
              addressId: 'x',
              label: 'broken',
              errorCode: 'RPC_TIMEOUT',
              matchesCriteria: false,
              nativeBalance: null,
              inactiveDays: null,
            },
          ],
          total: 2,
          page: 1,
          pageSize: 50,
        }),
    })
    renderAt(`/scans/${scan().id}`)

    expect(await screen.findByText('Wallet 2019')).toBeTruthy()
    expect(screen.getByText('1148')).toBeTruthy()
    expect(screen.getByText('0.5')).toBeTruthy()
    expect(screen.getByText('sesuai kriteria')).toBeTruthy()
    expect(screen.getByText('RPC_TIMEOUT')).toBeTruthy()
    expect(screen.getByText(/kriteria saldo 0.1 – ∞ ETH/)).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Sesuai kriteria' }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('filter=criteria'))).toBe(
        true,
      ),
    )
  })

  it('shows the failure reason of a failed scan', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ANALYST)),
      [`GET /api/scans/${scan().id}`]: () =>
        json(200, {
          scan: scan({
            status: 'FAILED',
            errorMessage: 'EXPLORER_API_KEY is not configured in the server .env',
          }),
        }),
      [`GET /api/scans/${scan().id}/results*`]: () =>
        json(200, { items: [], total: 0, page: 1, pageSize: 50 }),
    })
    renderAt(`/scans/${scan().id}`)
    expect((await screen.findByRole('alert')).textContent).toMatch(/EXPLORER_API_KEY/)
  })
})

describe('Address detail with scan data', () => {
  it('shows exact balances and scan history', async () => {
    const id = RESULT.addressId
    mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ANALYST)),
      [`GET /api/addresses/${id}/eligibility`]: () => json(200, { assets: [] }),
      [`GET /api/addresses/${id}/authorizations`]: () => json(200, { authorizations: [] }),
      [`GET /api/addresses/${id}`]: () =>
        json(200, {
          address: {
            id,
            network: { id: 'net-1', name: 'sepolia', displayName: NETWORK.displayName },
            address: RESULT.address,
            label: 'Wallet 2019',
            ownerReference: 'SELF',
            activityStatus: 'INACTIVE',
            balanceStatus: 'HAS_BALANCE',
            authorizationStatus: 'UNVERIFIED',
            recoveryStatus: 'NONE',
            recoveryReasons: [],
            eligibilityCheckedAt: null,
            reviewFlag: false,
            lastActivityAt: null,
            inactiveDays: 1148,
            lastScannedAt: '2026-10-02T08:00:09.000Z',
            archivedAt: null,
            createdAt: '2026-10-01T00:00:00.000Z',
            explorerUrl: null,
            estimatedValue: '246913.57802469',
            fiatCurrency: 'USD',
            valueSimulated: true,
          },
        }),
      [`GET /api/addresses/${id}/balances`]: () =>
        json(200, {
          balances: [
            {
              assetId: 'a1',
              symbol: 'ETH',
              name: 'Sepolia Ether',
              isNative: true,
              decimals: 18,
              quantity: '123456789012345678901',
              formatted: '123.456789012345678901',
              updatedAt: '2026-10-02T08:00:09.000Z',
              fiatCurrency: 'USD',
              fiatValue: '246913.58',
              price: '2000',
              priceSource: 'coingecko',
              pricedAt: '2026-10-02T08:00:00.000Z',
              simulated: true,
            },
          ],
        }),
      [`GET /api/addresses/${id}/activity`]: () =>
        json(200, {
          history: [
            {
              scanId: scan().id,
              scannedAt: '2026-10-02T08:00:09.000Z',
              thresholdDays: 730,
              activityStatus: 'INACTIVE',
              balanceStatus: 'HAS_BALANCE',
              inactiveDays: 1148,
              lastIncomingAt: null,
              lastOutgoingAt: '2023-08-10T00:00:00.000Z',
              incomingTxCount: 5,
              outgoingTxCount: 2,
              nonce: 2,
              reviewFlag: true,
              errorCode: null,
            },
          ],
        }),
    })
    renderAt(`/addresses/${id}`)
    // 21 significant digits survive untouched: no float conversion anywhere.
    expect(await screen.findByText('123.456789012345678901')).toBeTruthy()
    expect(await screen.findByText('perlu review')).toBeTruthy()
    expect(screen.getByText('5 / 2 · 2')).toBeTruthy()
    expect(screen.getByText('$246,913.58')).toBeTruthy()
    expect(screen.getAllByText('SIMULASI').length).toBeGreaterThan(0)
  })
})
