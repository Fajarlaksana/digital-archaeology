import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type {
  AssetEligibility,
  Me,
  PublicAddress,
  PublicDestination,
  PublicTransaction,
} from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const READ: Permission[] = [
  'networks:read',
  'addresses:read',
  'transactions:read',
  'destinations:read',
]
const ANALYST: Permission[] = [...READ, 'transactions:create']
const REVIEWER: Permission[] = [...READ, 'transactions:approve']

const ADDRESS_ID = '11111111-1111-4111-8111-111111111111'
const TX_ID = '66666666-6666-4666-8666-666666666666'

const tx = (overrides: Partial<PublicTransaction> = {}): PublicTransaction => ({
  id: TX_ID,
  status: 'CREATED',
  statusReason: null,
  network: {
    id: 'net-1',
    name: 'sepolia',
    displayName: 'Sepolia',
    isTestnet: true,
    chainId: 11155111,
  },
  source: {
    addressId: ADDRESS_ID,
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    label: 'Old wallet',
  },
  destination: {
    id: 'dest-1',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    label: 'Cold storage',
  },
  asset: { id: 'eth', symbol: 'ETH', decimals: 18, isNative: true, contractAddress: null },
  amount: '999470800000000000',
  amountFormatted: '0.9994708',
  sweep: true,
  nonce: 7,
  gasLimit: '21000',
  maxFeePerGas: '25200000000',
  maxPriorityFeePerGas: '1000000000',
  networkFee: '529200000000000',
  networkFeeFormatted: '0.0005292',
  nativeSymbol: 'ETH',
  estimatedValue: '1998.94160000',
  valueSimulated: true,
  fiatCurrency: 'USD',
  unsignedHash: `0x${'ab'.repeat(32)}`,
  unsignedPayload: { type: 'eip1559', nonce: 7 },
  txHash: null,
  createdBy: { id: 'analyst-1', name: 'Ana' },
  createdAt: '2026-10-05T01:00:00.000Z',
  approvals: [
    {
      id: 'ap-1',
      requestedBy: { id: 'analyst-1', name: 'Ana' },
      decidedBy: null,
      decision: null,
      reason: null,
      decidedAt: null,
      expiresAt: null,
    },
  ],
  ...overrides,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function detail(me: Me, routes: Record<string, (b: unknown) => Response> = {}) {
  return mockBackend({
    'GET /api/auth/me': () => json(200, me),
    [`GET /api/transactions/${TX_ID}`]: () => json(200, { transaction: tx() }),
    ...routes,
  })
}

describe('Transaction detail (SA 4.8 review)', () => {
  it('shows source, destination, asset, amount, fee and network again; read-only for AUDITOR', async () => {
    detail(session('AUDITOR', READ))
    renderAt(`/transactions/${TX_ID}`)
    const summary = await screen.findByRole('region', { name: 'Ringkasan transaksi' })
    for (const text of [
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      '0.9994708 ETH',
      '0.0005292 ETH',
      `0x${'ab'.repeat(32)}`,
    ]) {
      expect(within(summary).getByText(text)).toBeTruthy()
    }
    expect(within(summary).getByText(/chainId 11155111\) · nonce 7/)).toBeTruthy()
    expect(within(summary).getByText('SWEEP')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('REVIEWER approves with a reason', async () => {
    let body: unknown
    detail(session('REVIEWER', REVIEWER), {
      [`POST /api/transactions/${TX_ID}/approve`]: (b) => {
        body = b
        return json(200, { transaction: tx({ status: 'APPROVED' }) })
      },
    })
    renderAt(`/transactions/${TX_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    const form = screen.getByRole('form', { name: 'Approve transaksi' })
    const submit = within(form).getByRole('button', { name: 'Approve' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true) // reason required
    fireEvent.change(within(form).getByLabelText('Alasan'), {
      target: { value: 'Amount and destination checked' },
    })
    fireEvent.click(submit)
    await waitFor(() => expect(body).toEqual({ reason: 'Amount and destination checked' }))
  })

  it('shows why an expired preview cannot be approved', async () => {
    detail(session('REVIEWER', REVIEWER), {
      [`POST /api/transactions/${TX_ID}/approve`]: () =>
        json(409, {
          error: {
            code: 'TRANSACTION_EXPIRED',
            message: 'The preview is no longer valid (NONCE_CHANGED) — create a new preview',
          },
        }),
    })
    renderAt(`/transactions/${TX_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    fireEvent.change(screen.getByLabelText('Alasan'), { target: { value: 'Looks fine' } })
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Approve transaksi' })).getByRole('button', {
        name: 'Approve',
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(/NONCE_CHANGED/)
  })

  it('the creator holding REVIEWER gets no decision buttons', async () => {
    const me = session('REVIEWER', [...REVIEWER, 'transactions:create'])
    mockBackend({
      'GET /api/auth/me': () => json(200, me),
      [`GET /api/transactions/${TX_ID}`]: () =>
        json(200, { transaction: tx({ createdBy: { id: me.user.id, name: me.user.name } }) }),
    })
    renderAt(`/transactions/${TX_ID}`)
    expect(await screen.findByText(/approval harus dari REVIEWER lain/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Batalkan' })).toBeTruthy()
  })

  it('explains the expiry reason', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('AUDITOR', READ)),
      [`GET /api/transactions/${TX_ID}`]: () =>
        json(200, { transaction: tx({ status: 'EXPIRED', statusReason: 'FEE_ABOVE_CAP' }) }),
    })
    renderAt(`/transactions/${TX_ID}`)
    expect(await screen.findByText(/Fee jaringan naik di atas batas/)).toBeTruthy()
  })
})

describe('Creating a preview from the address page', () => {
  const address: PublicAddress = {
    id: ADDRESS_ID,
    network: { id: 'net-1', name: 'sepolia', displayName: 'Sepolia' },
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    label: 'Old wallet',
    ownerReference: 'SELF',
    activityStatus: 'INACTIVE',
    balanceStatus: 'HAS_BALANCE',
    authorizationStatus: 'VERIFIED',
    recoveryStatus: 'READY',
    recoveryReasons: [],
    eligibilityCheckedAt: '2026-10-05T00:00:00.000Z',
    reviewFlag: false,
    lastActivityAt: null,
    inactiveDays: 900,
    lastScannedAt: '2026-10-05T00:00:00.000Z',
    archivedAt: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    explorerUrl: null,
    estimatedValue: '2000.00000000',
    fiatCurrency: 'USD',
    valueSimulated: true,
  }
  const eth: AssetEligibility = {
    assetId: 'eth',
    symbol: 'ETH',
    isNative: true,
    status: 'READY',
    reason: null,
    quantity: '1000000000000000000',
    formatted: '1',
    feeEstimate: '529200000000000',
    valueFiat: '2000.00000000',
    feeFiat: '1.05840000',
    netFiat: '1998.94160000',
    fiatCurrency: 'USD',
    simulated: true,
    computedAt: '2026-10-05T00:00:00.000Z',
  }
  const destination = {
    id: 'dest-1',
    network: { id: 'net-1', name: 'sepolia', displayName: 'Sepolia', isTestnet: true },
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    label: 'Cold storage',
    status: 'APPROVED',
  } as PublicDestination

  function backend(previews: unknown[], active: PublicTransaction[] = []) {
    return mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ANALYST)),
      [`GET /api/addresses/${ADDRESS_ID}`]: () => json(200, { address }),
      [`GET /api/addresses/${ADDRESS_ID}/balances`]: () => json(200, { balances: [] }),
      [`GET /api/addresses/${ADDRESS_ID}/activity`]: () => json(200, { history: [] }),
      [`GET /api/addresses/${ADDRESS_ID}/authorizations`]: () => json(200, { authorizations: [] }),
      [`GET /api/addresses/${ADDRESS_ID}/eligibility`]: () => json(200, { assets: [eth] }),
      [`GET /api/transactions?addressId=${ADDRESS_ID}`]: () => json(200, { transactions: active }),
      'GET /api/destinations?status=APPROVED': () => json(200, { destinations: [destination] }),
      'POST /api/transactions/preview': (b) => {
        previews.push(b)
        return json(201, { transaction: tx() })
      },
      [`GET /api/transactions/${TX_ID}`]: () => json(200, { transaction: tx() }),
    })
  }

  it('previews a test transfer to an approved destination and opens the review page', async () => {
    const previews: unknown[] = []
    backend(previews)
    renderAt(`/addresses/${ADDRESS_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Buat preview' }))
    const form = screen.getByRole('form', { name: 'Buat preview transaksi' })
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: /Cold storage/ })).toBeTruthy(),
    )
    fireEvent.click(within(form).getByLabelText('Test transfer kecil'))
    fireEvent.change(within(form).getByLabelText('Jumlah (ETH)'), { target: { value: '0.001' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Buat preview' }))

    expect(await screen.findByRole('region', { name: 'Ringkasan transaksi' })).toBeTruthy()
    expect(previews).toEqual([
      { addressId: ADDRESS_ID, assetId: 'eth', destinationId: 'dest-1', amount: '0.001' },
    ])
  })

  it('links the transaction in flight instead of offering a new preview', async () => {
    backend([], [tx()])
    renderAt(`/addresses/${ADDRESS_ID}`)
    expect(await screen.findByText(/Transaksi aktif/)).toBeTruthy()
    expect(
      screen.getByRole('link', { name: /0\.9994708 ETH → Cold storage/ }).getAttribute('href'),
    ).toBe(`/transactions/${TX_ID}`)
    expect(screen.queryByRole('button', { name: 'Buat preview' })).toBeNull()
  })
})
