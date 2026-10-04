import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type { PublicTransaction, VaultStatus } from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const SUPER: Permission[] = [
  'networks:read',
  'addresses:read',
  'transactions:read',
  'vault:manage',
  'transactions:sign',
]
const TX_ID = '77777777-7777-4777-8777-777777777777'
const TX_HASH = `0x${'cd'.repeat(32)}`

const tx = (overrides: Partial<PublicTransaction> = {}): PublicTransaction => ({
  id: TX_ID,
  status: 'APPROVED',
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
  txHash: null,
  createdBy: { id: 'analyst-1', name: 'Ana' },
  createdAt: '2026-10-05T01:00:00.000Z',
  approvals: [
    {
      id: 'ap-1',
      requestedBy: { id: 'analyst-1', name: 'Ana' },
      decidedBy: { id: 'reviewer-1', name: 'Rina' },
      decision: 'APPROVED',
      reason: 'Checked',
      decidedAt: '2026-10-05T01:05:00.000Z',
      expiresAt: '2026-10-05T01:35:00.000Z',
    },
  ],
  ...overrides,
})

const vault = (unlocked: boolean): VaultStatus => ({
  initialized: true,
  unlocked,
  unlockedBy: unlocked ? 'u' : null,
  expiresAt: unlocked ? '2026-10-05T01:20:00.000Z' : null,
  unlockTtlMinutes: 10,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Signing', () => {
  it('lists APPROVED transactions and says when the vault is locked', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('SUPER_ADMIN', SUPER)),
      'GET /api/transactions?status=APPROVED': () => json(200, { transactions: [tx()] }),
      'GET /api/vault/status': () => json(200, vault(false)),
    })
    renderAt('/signing')
    expect(await screen.findByRole('link', { name: /0\.9994708 ETH → Cold storage/ })).toBeTruthy()
    expect((await screen.findByRole('status')).textContent).toMatch(/Vault terkunci/)
    expect(screen.getByText(/di-approve Rina/)).toBeTruthy()
  })

  it('signs by id only; neither request nor response carries key material or the raw tx', async () => {
    let attempts = 0
    let signBody: unknown
    const sent: string[] = []
    const respond = (status: number, body: unknown) => {
      sent.push(JSON.stringify(body))
      return json(status, body)
    }
    const fetchMock = mockBackend({
      'GET /api/auth/me': () => respond(200, session('SUPER_ADMIN', SUPER)),
      [`GET /api/transactions/${TX_ID}`]: () =>
        respond(200, {
          transaction: attempts >= 2 ? tx({ status: 'SIGNED', txHash: TX_HASH }) : tx(),
        }),
      [`POST /api/transactions/${TX_ID}/sign`]: (body) => {
        signBody = body
        return ++attempts === 1
          ? respond(403, { error: { code: 'REAUTH_REQUIRED', message: 'Please confirm' } })
          : respond(200, { transaction: tx({ status: 'SIGNED', txHash: TX_HASH }) })
      },
      'POST /api/auth/reauth': () => new Response(null, { status: 204 }),
    })
    renderAt(`/transactions/${TX_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign' }))
    const panel = await screen.findByRole('form', { name: 'Konfirmasi identitas' })
    fireEvent.change(within(panel).getByLabelText('Password akun'), {
      target: { value: 'correct horse battery' },
    })
    fireEvent.change(within(panel).getByLabelText('Kode authenticator'), {
      target: { value: '123456' },
    })
    fireEvent.click(within(panel).getByRole('button', { name: 'Konfirmasi' }))

    expect(await screen.findByText(TX_HASH)).toBeTruthy()
    expect(attempts).toBe(2)
    expect(signBody).toEqual({}) // only the id (in the URL) — never a payload
    const bodies = fetchMock.mock.calls.map(([, init]) => String(init?.body ?? ''))
    for (const text of [...sent, ...bodies]) {
      expect(text).not.toMatch(/"privateKey"|"signedPayload"|"signedTransaction"/)
    }
  })

  it('no Sign button for the SUPER_ADMIN who approved it', async () => {
    const me = session('SUPER_ADMIN', [...SUPER, 'transactions:approve'])
    mockBackend({
      'GET /api/auth/me': () => json(200, me),
      [`GET /api/transactions/${TX_ID}`]: () =>
        json(200, {
          transaction: tx({
            approvals: [
              { ...tx().approvals[0]!, decidedBy: { id: me.user.id, name: me.user.name } },
            ],
          }),
        }),
    })
    renderAt(`/transactions/${TX_ID}`)
    expect(await screen.findByText(/tanda tangan harus dari SUPER_ADMIN lain/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull()
  })

  it('is hidden from users without transactions:sign', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('REVIEWER', ['transactions:read'])),
      [`GET /api/transactions/${TX_ID}`]: () => json(200, { transaction: tx() }),
    })
    renderAt(`/transactions/${TX_ID}`)
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Ringkasan transaksi' })).toBeTruthy(),
    )
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull()
  })
})
