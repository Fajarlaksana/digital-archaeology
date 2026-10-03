import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type { Me, PublicDestination, PublicNetwork } from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const READ: Permission[] = ['networks:read', 'addresses:read', 'destinations:read']
const ANALYST: Permission[] = [...READ, 'destinations:create']
const REVIEWER: Permission[] = [...READ, 'destinations:approve']

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

const ANALYST_PERSON = { id: 'analyst-1', name: 'Ana' }

const pending = (overrides: Partial<PublicDestination> = {}): PublicDestination => ({
  id: '44444444-4444-4444-8444-444444444444',
  network: { id: NETWORK.id, name: 'sepolia', displayName: 'Sepolia', isTestnet: true },
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  label: 'Cold storage 2026',
  status: 'PENDING_APPROVAL',
  statusReason: null,
  controlVerifiedAt: null,
  controlVerifiedBy: null,
  createdBy: ANALYST_PERSON,
  createdAt: '2026-10-04T00:00:00.000Z',
  approvals: [
    {
      id: 'ap-1',
      requestedBy: ANALYST_PERSON,
      decidedBy: null,
      decision: null,
      reason: null,
      decidedAt: null,
      createdAt: '2026-10-04T00:00:00.000Z',
    },
  ],
  challenges: [],
  ...overrides,
})

const proven = (overrides: Partial<PublicDestination> = {}) =>
  pending({
    controlVerifiedAt: '2026-10-04T00:05:00.000Z',
    controlVerifiedBy: ANALYST_PERSON,
    ...overrides,
  })

const CHALLENGE = {
  id: '55555555-5555-4555-8555-555555555555',
  address: pending().address,
  message: 'Digital Archaeology — Destination Verification\n…',
  expiresAt: '2026-10-04T00:15:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function backend(
  me: Me,
  list: PublicDestination[],
  routes: Record<string, (b: unknown) => Response>,
) {
  return mockBackend({
    'GET /api/auth/me': () => json(200, me),
    'GET /api/destinations*': () => json(200, { destinations: list }),
    'GET /api/networks': () => json(200, { networks: [NETWORK] }),
    ...routes,
  })
}

describe('Destinations page', () => {
  it('is read-only for AUDITOR', async () => {
    backend(session('AUDITOR', READ), [proven()], {})
    renderAt('/destinations')
    expect(await screen.findByText('Cold storage 2026')).toBeTruthy()
    expect(screen.getByText(/terverifikasi/)).toBeTruthy()
    for (const name of ['Tambah destination', 'Approve', 'Tolak', 'Buktikan kendali']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('lets ANALYST add a destination and prove control with a pasted signature', async () => {
    let created: unknown
    let submitted: unknown
    backend(session('ANALYST', ANALYST), [pending()], {
      'POST /api/destinations': (body) => {
        created = body
        return json(201, { destination: pending() })
      },
      [`POST /api/destinations/${pending().id}/challenges`]: () =>
        json(201, { challenge: CHALLENGE }),
      [`POST /api/destination-challenges/${CHALLENGE.id}/signature`]: (body) => {
        submitted = body
        return json(200, { result: 'VERIFIED', destination: proven() })
      },
    })
    renderAt('/destinations')
    fireEvent.click(await screen.findByRole('button', { name: 'Tambah destination' }))
    const form = screen.getByRole('form', { name: 'Tambah destination' })
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Sepolia' })).toBeTruthy())
    fireEvent.change(within(form).getByLabelText('Address tujuan'), {
      target: { value: ' 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 ' },
    })
    fireEvent.change(within(form).getByLabelText('Label'), { target: { value: 'Cold storage' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Simpan' }))
    await waitFor(() =>
      expect(created).toEqual({
        networkId: NETWORK.id,
        address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        label: 'Cold storage',
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Buktikan kendali' }))
    expect((await screen.findByLabelText('Pesan challenge')).textContent).toContain(
      'Destination Verification',
    )
    const signature = `0x${'2'.repeat(130)}`
    fireEvent.change(screen.getByLabelText(/^Signature/), { target: { value: signature } })
    fireEvent.click(screen.getByRole('button', { name: 'Kirim signature' }))
    expect(await screen.findByText(/Kendali atas address tujuan terbukti/)).toBeTruthy()
    expect(submitted).toEqual({ signature, method: 'MANUAL' })
    // ANALYST never gets decision buttons.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('REVIEWER approves only after proof, re-authenticating when asked', async () => {
    let attempts = 0
    backend(
      session('REVIEWER', REVIEWER),
      [pending(), proven({ id: 'proven-1', label: 'Proven' })],
      {
        'POST /api/destinations/proven-1/approve': () =>
          ++attempts === 1
            ? json(403, { error: { code: 'REAUTH_REQUIRED', message: 'Please confirm' } })
            : json(200, { destination: proven({ id: 'proven-1', status: 'APPROVED' }) }),
        'POST /api/auth/reauth': () => new Response(null, { status: 204 }),
      },
    )
    renderAt('/destinations')
    const ready = (await screen.findByText('Proven')).closest('li')!
    const unproven = screen.getByText('Cold storage 2026').closest('li')!
    expect(
      (within(unproven).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(within(unproven).getByText(/setelah pemilik address tujuan membuktikan/)).toBeTruthy()

    fireEvent.click(within(ready).getByRole('button', { name: 'Approve' }))
    const panel = await within(ready).findByRole('form', { name: 'Konfirmasi identitas' })
    fireEvent.change(within(panel).getByLabelText('Password akun'), {
      target: { value: 'correct horse battery' },
    })
    fireEvent.change(within(panel).getByLabelText('Kode authenticator'), {
      target: { value: '123456' },
    })
    fireEvent.click(within(panel).getByRole('button', { name: 'Konfirmasi' }))
    await waitFor(() => expect(attempts).toBe(2))
  })

  it('REVIEWER rejects with a reason', async () => {
    let rejected: unknown
    backend(session('REVIEWER', REVIEWER), [proven()], {
      [`POST /api/destinations/${pending().id}/reject`]: (body) => {
        rejected = body
        return json(200, { destination: proven({ status: 'REJECTED', statusReason: 'Unknown' }) })
      },
    })
    renderAt('/destinations')
    fireEvent.click(await screen.findByRole('button', { name: 'Tolak' }))
    const form = screen.getByRole('form', { name: 'Tolak destination' })
    const submit = within(form).getByRole('button', { name: 'Tolak' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(form).getByLabelText('Alasan'), {
      target: { value: 'Unknown wallet' },
    })
    fireEvent.click(submit)
    await waitFor(() => expect(rejected).toEqual({ reason: 'Unknown wallet' }))
  })

  it('hides decisions from a REVIEWER who requested or proved the destination', async () => {
    const me = session('REVIEWER', [...REVIEWER, 'destinations:create'])
    backend(me, [proven({ controlVerifiedBy: { id: me.user.id, name: me.user.name } })], {})
    renderAt('/destinations')
    expect(await screen.findByText(/REVIEWER lain/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tolak' })).toBeNull()
  })
})
