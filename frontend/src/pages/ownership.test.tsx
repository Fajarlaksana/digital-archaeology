import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type { PublicAddress, PublicAuthorization } from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const READ: Permission[] = ['networks:read', 'addresses:read', 'authorizations:read']
const ANALYST: Permission[] = [...READ, 'addresses:manage', 'ownership:verify']
const SUPER: Permission[] = [...READ, 'vault:manage', 'ownership:verify']

const ADDRESS: PublicAddress = {
  id: '11111111-1111-4111-8111-111111111111',
  network: { id: 'net-1', name: 'sepolia', displayName: 'Sepolia' },
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  label: 'Old wallet',
  ownerReference: 'SELF',
  activityStatus: 'INACTIVE',
  balanceStatus: 'HAS_BALANCE',
  authorizationStatus: 'PENDING',
  recoveryStatus: 'NONE',
  reviewFlag: false,
  lastActivityAt: null,
  inactiveDays: 400,
  lastScannedAt: null,
  archivedAt: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  explorerUrl: null,
  estimatedValue: null,
  fiatCurrency: 'USD',
  valueSimulated: false,
}

const AUTH: PublicAuthorization = {
  id: '22222222-2222-4222-8222-222222222222',
  address: { id: ADDRESS.id, address: ADDRESS.address, label: 'Old wallet', network: 'Sepolia' },
  type: 'SELF',
  reference: 'Own wallet since 2017',
  documentName: 'statement.pdf',
  documentSha256: 'ab'.repeat(32),
  status: 'PENDING',
  verifiedAt: null,
  expiresAt: null,
  createdAt: '2026-10-03T00:00:00.000Z',
  challenges: [],
}

const CHALLENGE = {
  id: '33333333-3333-4333-8333-333333333333',
  address: ADDRESS.address,
  message: 'Digital Archaeology — Ownership Verification\n\nAddress: 0xf39F…',
  expiresAt: '2026-10-03T00:15:00.000Z',
}
const SIGNATURE = `0x${'1'.repeat(130)}`
const VERIFIED = { result: 'VERIFIED', authorization: { ...AUTH, status: 'VERIFIED' } }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function backend(
  perms: Permission[],
  role: Parameters<typeof session>[0],
  routes: Record<string, (body: unknown) => Response>,
) {
  return mockBackend({
    'GET /api/auth/me': () => json(200, session(role, perms)),
    [`GET /api/addresses/${ADDRESS.id}`]: () => json(200, { address: ADDRESS }),
    [`GET /api/addresses/${ADDRESS.id}/balances`]: () => json(200, { balances: [] }),
    [`GET /api/addresses/${ADDRESS.id}/activity`]: () => json(200, { history: [] }),
    [`GET /api/addresses/${ADDRESS.id}/authorizations`]: () =>
      json(200, { authorizations: [AUTH] }),
    [`POST /api/authorizations/${AUTH.id}/challenges`]: () => json(201, { challenge: CHALLENGE }),
    ...routes,
  })
}

async function openChallenge() {
  renderAt(`/addresses/${ADDRESS.id}`)
  fireEvent.click(await screen.findByRole('button', { name: 'Buat challenge verifikasi' }))
  return screen.findByLabelText('Pesan challenge')
}

describe('Ownership verification', () => {
  it('shows authorizations read-only for users without ownership:verify', async () => {
    backend(READ, 'AUDITOR', {})
    renderAt(`/addresses/${ADDRESS.id}`)
    expect(await screen.findByText('Own wallet since 2017')).toBeTruthy()
    expect(screen.getByText(/statement\.pdf/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Buat challenge verifikasi' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tambah otorisasi' })).toBeNull()
  })

  it('hashes the document in the browser and sends only its fingerprint', async () => {
    let created: unknown
    const fetchMock = backend(ANALYST, 'ANALYST', {
      [`POST /api/addresses/${ADDRESS.id}/authorizations`]: (body) => {
        created = body
        return json(201, { authorization: AUTH })
      },
    })
    renderAt(`/addresses/${ADDRESS.id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Tambah otorisasi' }))
    const form = screen.getByRole('form', { name: 'Tambah otorisasi' })
    fireEvent.change(within(form).getByLabelText(/^Jenis otorisasi/), {
      target: { value: 'MANDATE' },
    })
    fireEvent.change(within(form).getByLabelText(/^Referensi/), {
      target: { value: 'Surat kuasa 12/2026' },
    })
    const file = new File(['abc'], 'kuasa.pdf', { type: 'application/pdf' })
    fireEvent.change(within(form).getByLabelText(/^Dokumen pendukung/), {
      target: { files: [file] },
    })
    // SHA-256("abc"), the FIPS 180-2 test vector.
    const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(await within(form).findByText(`SHA-256: ${digest}`)).toBeTruthy()
    fireEvent.click(within(form).getByRole('button', { name: 'Simpan otorisasi' }))

    await waitFor(() => expect(created).toBeTruthy())
    expect(created).toEqual({
      type: 'MANDATE',
      reference: 'Surat kuasa 12/2026',
      documentSha256: digest,
      documentName: 'kuasa.pdf',
      expiresAt: null,
    })
    // Only JSON bodies are sent: the file itself never leaves the browser.
    expect(fetchMock.mock.calls.every(([, init]) => !(init?.body instanceof FormData))).toBe(true)
  })

  it('signs with the browser wallet when its active account is the address', async () => {
    let submitted: unknown
    const request = vi.fn(async (args: { method: string; params?: unknown[] }) =>
      args.method === 'eth_requestAccounts' ? [ADDRESS.address.toLowerCase()] : SIGNATURE,
    )
    vi.stubGlobal('ethereum', { request })
    backend(ANALYST, 'ANALYST', {
      [`POST /api/challenges/${CHALLENGE.id}/signature`]: (body) => {
        submitted = body
        return json(200, VERIFIED)
      },
    })
    expect((await openChallenge()).textContent).toContain('Ownership Verification')
    fireEvent.click(screen.getByRole('button', { name: 'Tanda tangani dengan wallet browser' }))

    expect(await screen.findByText(/Kepemilikan terverifikasi/)).toBeTruthy()
    expect(submitted).toEqual({ signature: SIGNATURE, method: 'WALLET' })
    const sign = request.mock.calls.find(([args]) => args.method === 'personal_sign')?.[0]
    const hex = String(sign?.params?.[0]).slice(2)
    const bytes = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))
    expect(new TextDecoder().decode(bytes)).toBe(CHALLENGE.message)
    expect(screen.queryByRole('button', { name: 'Tanda tangani dengan Key Vault' })).toBeNull()
  })

  it('refuses to sign when the wallet account is a different address', async () => {
    vi.stubGlobal('ethereum', {
      request: async (args: { method: string }) =>
        args.method === 'eth_requestAccounts'
          ? ['0x70997970c51812dc3a010c7d01b50e0d17dc79c8']
          : SIGNATURE,
    })
    const fetchMock = backend(ANALYST, 'ANALYST', {})
    await openChallenge()
    fireEvent.click(screen.getByRole('button', { name: 'Tanda tangani dengan wallet browser' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Akun aktif di wallet bukan/)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/signature'))).toBe(false)
  })

  it('submits a pasted signature and shows a rejection', async () => {
    backend(ANALYST, 'ANALYST', {
      [`POST /api/challenges/${CHALLENGE.id}/signature`]: () =>
        json(400, {
          error: {
            code: 'SIGNATURE_INVALID',
            message: 'The signature was not made by this address for this challenge',
          },
        }),
    })
    await openChallenge()
    expect(screen.queryByRole('button', { name: 'Tanda tangani dengan wallet browser' })).toBeNull()
    fireEvent.change(screen.getByLabelText(/^Signature/), { target: { value: SIGNATURE } })
    fireEvent.click(screen.getByRole('button', { name: 'Kirim signature' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/not made by this address/)
  })

  it('lets SUPER_ADMIN sign with the vault, asking for re-authentication first', async () => {
    let attempts = 0
    let reauth: unknown
    backend(SUPER, 'SUPER_ADMIN', {
      [`POST /api/challenges/${CHALLENGE.id}/vault-signature`]: () =>
        ++attempts === 1
          ? json(403, { error: { code: 'REAUTH_REQUIRED', message: 'Re-authentication required' } })
          : json(200, VERIFIED),
      'POST /api/auth/reauth': (body) => {
        reauth = body
        return new Response(null, { status: 204 })
      },
    })
    await openChallenge()
    fireEvent.click(screen.getByRole('button', { name: 'Tanda tangani dengan Key Vault' }))
    const panel = await screen.findByRole('form', { name: 'Konfirmasi identitas' })
    fireEvent.change(within(panel).getByLabelText('Password akun'), {
      target: { value: 'correct horse battery' },
    })
    fireEvent.change(within(panel).getByLabelText('Kode authenticator'), {
      target: { value: '123456' },
    })
    fireEvent.click(within(panel).getByRole('button', { name: 'Konfirmasi' }))

    expect(await screen.findByText(/Kepemilikan terverifikasi/)).toBeTruthy()
    expect(reauth).toEqual({ password: 'correct horse battery', code: '123456' })
    expect(attempts).toBe(2)
  })
})

describe('Authorizations page', () => {
  it('lists authorizations with a status filter and links to the address', async () => {
    const fetchMock = mockBackend({
      'GET /api/auth/me': () => json(200, session('AUDITOR', READ)),
      'GET /api/authorizations*': () => json(200, { authorizations: [AUTH] }),
    })
    renderAt('/authorizations')
    expect(await screen.findByRole('heading', { name: 'Authorizations' })).toBeTruthy()
    const link = await screen.findByRole('link', { name: 'Old wallet' })
    expect(link.getAttribute('href')).toBe(`/addresses/${ADDRESS.id}`)
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'VERIFIED' } })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url) === '/api/authorizations?status=VERIFIED'),
      ).toBe(true),
    )
  })
})
