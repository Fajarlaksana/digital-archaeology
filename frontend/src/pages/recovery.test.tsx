import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type { AssetEligibility, PublicAddress, PublicNetwork } from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const READ: Permission[] = ['networks:read', 'addresses:read', 'reports:read', 'transactions:read']
const ANALYST: Permission[] = [...READ, 'scans:run']

const NETWORK: PublicNetwork = {
  id: 'net-1',
  name: 'sepolia',
  displayName: 'Sepolia',
  chainType: 'EVM',
  chainId: 11155111,
  isTestnet: true,
  rpcUrlEnv: null,
  rpcConfigured: true,
  explorerUrl: null,
  status: 'ACTIVE',
  assets: [],
}

const address = (overrides: Partial<PublicAddress> = {}): PublicAddress => ({
  id: '11111111-1111-4111-8111-111111111111',
  network: { id: NETWORK.id, name: 'sepolia', displayName: 'Sepolia' },
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  label: 'Old wallet',
  ownerReference: 'SELF',
  activityStatus: 'INACTIVE',
  balanceStatus: 'HAS_BALANCE',
  authorizationStatus: 'VERIFIED',
  recoveryStatus: 'NOT_ELIGIBLE',
  recoveryReasons: ['NEEDS_GAS_FUNDING'],
  eligibilityCheckedAt: '2026-10-04T02:10:00.000Z',
  reviewFlag: false,
  lastActivityAt: null,
  inactiveDays: 900,
  lastScannedAt: '2026-10-04T02:00:00.000Z',
  archivedAt: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  explorerUrl: null,
  estimatedValue: '500.00000000',
  fiatCurrency: 'USD',
  valueSimulated: true,
  ...overrides,
})

const CONFIG = {
  minNetValue: '10',
  feeMarginPercent: 20,
  balanceMaxAgeHours: 36,
  fiatCurrency: 'USD',
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function backend(perms: Permission[], role: 'AUDITOR' | 'ANALYST', extra = {}) {
  return mockBackend({
    'GET /api/auth/me': () => json(200, session(role, perms)),
    'GET /api/networks': () => json(200, { networks: [NETWORK] }),
    'GET /api/eligibility/config': () => json(200, CONFIG),
    'GET /api/addresses*': () =>
      json(200, { items: [address()], total: 1, page: 1, pageSize: 200 }),
    ...extra,
  })
}

describe('Recovery page', () => {
  it('shows status, reasons with the next action, the rules and the CSV link', async () => {
    backend(READ, 'AUDITOR')
    renderAt('/recovery')
    expect(await screen.findByText('Perlu dana gas')).toBeTruthy()
    expect(screen.getByText(/top-up gas atau abaikan/)).toBeTruthy()
    expect(within(screen.getByRole('table')).getByText('NOT_ELIGIBLE')).toBeTruthy()
    expect(await screen.findByText(/nilai bersih minimum \$10\.00/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /laporan kelayakan/ }).getAttribute('href')).toBe(
      '/api/reports/eligibility.csv',
    )
    expect(screen.queryByRole('button', { name: 'Hitung ulang' })).toBeNull()
    expect(screen.getByText(/tidak ada\s+aset yang dipindahkan otomatis/)).toBeTruthy()
  })

  it('filters by status through the API', async () => {
    const fetchMock = backend(READ, 'AUDITOR')
    renderAt('/recovery')
    await screen.findByText('Perlu dana gas')
    fireEvent.change(screen.getByLabelText('Status kelayakan'), { target: { value: 'READY' } })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url).includes('recoveryStatus=READY') &&
            String(url).includes(`networkId=${NETWORK.id}`),
        ),
      ).toBe(true),
    )
  })

  it('lets ANALYST re-evaluate a network and shows the summary', async () => {
    let body: unknown
    backend(ANALYST, 'ANALYST', {
      'POST /api/eligibility/evaluate': (b: unknown) => {
        body = b
        return json(200, {
          networkId: NETWORK.id,
          evaluated: 3,
          ready: 1,
          notEligible: 1,
          notEconomic: 1,
          feeError: null,
          computedAt: '2026-10-04T03:00:00.000Z',
        })
      },
    })
    renderAt('/recovery')
    const button = (await screen.findByRole('button', {
      name: 'Hitung ulang',
    })) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false)) // enabled once networks loaded
    fireEvent.click(button)
    expect((await screen.findByRole('status')).textContent).toMatch(
      /3 address dinilai: 1 READY, 1 NOT_ECONOMIC, 1 NOT_ELIGIBLE/,
    )
    expect(body).toEqual({ networkId: NETWORK.id })
  })
})

describe('Address detail eligibility', () => {
  it('shows per-asset results with fees, net values and the SIMULASI label', async () => {
    const assets: AssetEligibility[] = [
      {
        assetId: 'eth',
        symbol: 'ETH',
        isNative: true,
        status: 'NOT_ECONOMIC',
        reason: 'FEE_EXCEEDS_BALANCE',
        quantity: '100',
        formatted: '0.0000000000000001',
        feeEstimate: '529200000000000',
        valueFiat: '0.00000000',
        feeFiat: '1.05840000',
        netFiat: '0.00000000',
        fiatCurrency: 'USD',
        simulated: true,
        computedAt: '2026-10-04T02:10:00.000Z',
      },
      {
        assetId: 'usdc',
        symbol: 'USDC',
        isNative: false,
        status: 'NOT_ELIGIBLE',
        reason: 'NEEDS_GAS_FUNDING',
        quantity: '500000000',
        formatted: '500',
        feeEstimate: '1260000000000000',
        valueFiat: '500.00000000',
        feeFiat: '2.52000000',
        netFiat: '497.48000000',
        fiatCurrency: 'USD',
        simulated: true,
        computedAt: '2026-10-04T02:10:00.000Z',
      },
    ]
    const a = address()
    mockBackend({
      'GET /api/auth/me': () => json(200, session('AUDITOR', READ)),
      [`GET /api/addresses/${a.id}`]: () => json(200, { address: a }),
      [`GET /api/addresses/${a.id}/balances`]: () => json(200, { balances: [] }),
      [`GET /api/addresses/${a.id}/activity`]: () => json(200, { history: [] }),
      [`GET /api/addresses/${a.id}/authorizations`]: () => json(200, { authorizations: [] }),
      [`GET /api/addresses/${a.id}/eligibility`]: () => json(200, { assets }),
    })
    renderAt(`/addresses/${a.id}`)
    const section = (await screen.findByRole('heading', { name: /Kelayakan recovery/ })).closest(
      'section',
    )!
    const usdc = (await within(section).findByText('USDC')).closest('tr')!
    expect(within(usdc).getByText('$497.48')).toBeTruthy()
    expect(within(usdc).getByText('$2.52')).toBeTruthy()
    expect(within(usdc).getByText('SIMULASI')).toBeTruthy()
    expect(within(usdc).getByText('Perlu dana gas')).toBeTruthy()
    expect(within(section).getByText(/top-up gas atau abaikan/)).toBeTruthy()
  })
})
