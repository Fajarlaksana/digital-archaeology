import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type { PublicTransaction } from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const SUPER: Permission[] = ['transactions:read', 'transactions:sign', 'transactions:broadcast']
const READ: Permission[] = ['transactions:read']
const TX_ID = '88888888-8888-4888-8888-888888888888'
const TX_HASH = `0x${'ef'.repeat(32)}`

const tx = (overrides: Partial<PublicTransaction> = {}): PublicTransaction => ({
  id: TX_ID,
  status: 'SIGNED',
  statusReason: null,
  network: {
    id: 'net-1',
    name: 'sepolia',
    displayName: 'Sepolia',
    isTestnet: true,
    chainId: 11155111,
  },
  source: {
    addressId: 'addr-1',
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
  estimatedValue: null,
  valueSimulated: true,
  fiatCurrency: 'USD',
  unsignedHash: `0x${'ab'.repeat(32)}`,
  unsignedPayload: { type: 'eip1559', nonce: 7 },
  txHash: TX_HASH,
  explorerTxUrl: null,
  broadcastAt: null,
  confirmations: 0,
  requiredConfirmations: 3,
  blockNumber: null,
  feePaid: null,
  feePaidFormatted: null,
  confirmedAt: null,
  failureReason: null,
  stuck: false,
  createdBy: { id: 'analyst-1', name: 'Ana' },
  createdAt: '2026-10-05T01:00:00.000Z',
  approvals: [],
  ...overrides,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function show(perms: Permission[], transaction: PublicTransaction, routes = {}) {
  return mockBackend({
    'GET /api/auth/me': () => json(200, session('SUPER_ADMIN', perms)),
    [`GET /api/transactions/${TX_ID}`]: () => json(200, { transaction }),
    ...routes,
  })
}

describe('Broadcast & confirmation', () => {
  it('broadcast needs an explicit confirmation and sends only the id', async () => {
    let body: unknown
    show(SUPER, tx(), {
      [`POST /api/transactions/${TX_ID}/broadcast`]: (b: unknown) => {
        body = b
        return json(200, {
          transaction: tx({ status: 'BROADCASTED', broadcastAt: '2026-10-05T02:00:00.000Z' }),
        })
      },
    })
    renderAt(`/transactions/${TX_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Broadcast' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Konfirmasi broadcast' })
    expect(dialog.textContent).toMatch(/0\.9994708 ETH ke Cold storage di Sepolia/)
    expect(body).toBeUndefined() // nothing sent before the confirmation
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ya, broadcast sekarang' }))
    await waitFor(() => expect(body).toEqual({}))
  })

  it('no Broadcast button without transactions:broadcast', async () => {
    show(READ, tx())
    renderAt(`/transactions/${TX_ID}`)
    await screen.findByRole('region', { name: 'Ringkasan transaksi' })
    expect(screen.queryByRole('button', { name: 'Broadcast' })).toBeNull()
  })

  it('shows confirmations, block, actual fee and the explorer link once confirmed', async () => {
    show(
      READ,
      tx({
        status: 'CONFIRMED',
        broadcastAt: '2026-10-05T02:00:00.000Z',
        confirmedAt: '2026-10-05T02:01:00.000Z',
        confirmations: 3,
        blockNumber: '200',
        feePaid: '252000000000000',
        feePaidFormatted: '0.000252',
        explorerTxUrl: `https://sepolia.etherscan.io/tx/${TX_HASH}`,
      }),
    )
    renderAt(`/transactions/${TX_ID}`)
    const status = await screen.findByRole('region', { name: 'Status jaringan' })
    expect(within(status).getByText('3 / 3')).toBeTruthy()
    expect(within(status).getByText('200')).toBeTruthy()
    expect(within(status).getByText('0.000252 ETH')).toBeTruthy()
    expect(
      within(status)
        .getByRole('link', { name: /explorer/ })
        .getAttribute('href'),
    ).toBe(`https://sepolia.etherscan.io/tx/${TX_HASH}`)
    expect(screen.getByText(/Selesai: aset sudah dipindahkan/)).toBeTruthy()
  })

  it('warns about a STUCK transaction and explains failures', async () => {
    show(READ, tx({ status: 'BROADCASTED', broadcastAt: '2026-10-05T02:00:00.000Z', stuck: true }))
    renderAt(`/transactions/${TX_ID}`)
    expect((await screen.findByRole('alert')).textContent).toMatch(/STUCK/)
    cleanup()

    show(
      READ,
      tx({
        status: 'FAILED',
        statusReason: 'REVERTED',
        failureReason: 'REVERTED',
        broadcastAt: '2026-10-05T02:00:00.000Z',
      }),
    )
    renderAt(`/transactions/${TX_ID}`)
    expect(await screen.findByText(/gagal dieksekusi \(reverted\)/)).toBeTruthy()
  })
})
