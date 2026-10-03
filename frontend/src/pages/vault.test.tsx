import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type { VaultKey, VaultStatus } from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const SUPER: Permission[] = ['networks:read', 'addresses:read', 'vault:manage', 'transactions:sign']
/* Public Hardhat test key — never real funds. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ADDRESS_ID = '11111111-1111-4111-8111-111111111111'

const status = (overrides: Partial<VaultStatus> = {}): VaultStatus => ({
  initialized: true,
  unlocked: false,
  unlockedBy: null,
  expiresAt: null,
  unlockTtlMinutes: 10,
  ...overrides,
})

const KEY: VaultKey = {
  chainType: 'EVM',
  address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  checksumAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  keyType: 'PRIVATE_KEY',
  derivationPath: null,
  importedBy: 'u1',
  createdAt: '2026-10-03T00:00:00.000Z',
  lastUsedAt: null,
  inventory: [
    {
      addressId: ADDRESS_ID,
      label: 'Old wallet',
      archived: false,
      network: { id: 'n1', displayName: 'Sepolia' },
    },
  ],
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function backend(routes: Record<string, (body: unknown) => Response>) {
  return mockBackend({
    'GET /api/auth/me': () => json(200, session('SUPER_ADMIN', SUPER)),
    'GET /api/addresses*': () => json(200, { items: [], total: 0, page: 1, pageSize: 200 }),
    'GET /api/vault/keys': () => json(200, { keys: [] }),
    ...routes,
  })
}

describe('Key Vault page', () => {
  it('is hidden from users without vault:manage', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('ADMIN', ['users:read', 'networks:read'])),
    })
    renderAt('/key-vault')
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy()
  })

  it('initialises only with matching, long-enough, distinct passphrases and an acknowledgement', async () => {
    let initBody: unknown
    let initialized = false
    backend({
      'GET /api/vault/status': () => json(200, status({ initialized })),
      'POST /api/vault/init': (body) => {
        initBody = body
        initialized = true
        return json(200, status())
      },
    })
    renderAt('/key-vault')
    const form = await screen.findByRole('form', { name: 'Inisialisasi vault' })
    // Prefix match: the recovery field's accessible name also contains its safety hint.
    const fill = (label: string, value: string) =>
      fireEvent.change(within(form).getByLabelText(new RegExp(`^${label}`)), { target: { value } })
    const submit = within(form).getByRole('button', { name: 'Inisialisasi' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(form).getByRole('checkbox'))

    fill('Passphrase utama', 'too short')
    fill('Ulangi passphrase utama', 'too short')
    fireEvent.click(submit)
    expect(within(form).getByRole('alert').textContent).toMatch(/Minimal 16/)

    fill('Passphrase utama', 'marble orbit cactus lantern')
    fill('Ulangi passphrase utama', 'marble orbit cactus lantern')
    fill('Recovery passphrase', 'marble orbit cactus lantern')
    fill('Ulangi recovery passphrase', 'marble orbit cactus lantern')
    fireEvent.click(submit)
    expect(within(form).getByRole('alert').textContent).toMatch(/harus berbeda/)
    expect(initBody).toBeUndefined()

    fill('Recovery passphrase', 'violet harbor tundra pencil quartz')
    fill('Ulangi recovery passphrase', 'violet harbor tundra pencil quartz')
    fireEvent.click(submit)
    await waitFor(() =>
      expect(initBody).toEqual({
        passphrase: 'marble orbit cactus lantern',
        recoveryPassphrase: 'violet harbor tundra pencil quartz',
      }),
    )
    expect(await screen.findByRole('form', { name: 'Buka vault' })).toBeTruthy()
  })

  it('asks for re-authentication when required, then retries the action', async () => {
    let reauthed = false
    let unlocked = false
    const fetchMock = backend({
      'GET /api/vault/status': () =>
        json(
          200,
          status({
            unlocked,
            expiresAt: unlocked ? new Date(Date.now() + 600_000).toISOString() : null,
          }),
        ),
      'POST /api/vault/unlock': () => {
        if (!reauthed)
          return json(403, {
            error: { code: 'REAUTH_REQUIRED', message: 'Please confirm your password to continue' },
          })
        unlocked = true
        return json(200, status({ unlocked: true }))
      },
      'POST /api/auth/reauth': () => {
        reauthed = true
        return new Response(null, { status: 204 })
      },
    })
    renderAt('/key-vault')
    const unlockForm = await screen.findByRole('form', { name: 'Buka vault' })
    fireEvent.change(within(unlockForm).getByLabelText('Passphrase vault'), {
      target: { value: 'marble orbit cactus lantern' },
    })
    fireEvent.click(within(unlockForm).getByRole('button', { name: 'Buka' }))

    const reauth = await screen.findByRole('form', { name: 'Konfirmasi identitas' })
    fireEvent.change(within(reauth).getByLabelText('Password akun'), {
      target: { value: 'account password' },
    })
    fireEvent.change(within(reauth).getByLabelText('Kode authenticator'), {
      target: { value: '123456' },
    })
    fireEvent.click(within(reauth).getByRole('button', { name: 'Konfirmasi' }))

    expect(await screen.findByText('TERBUKA')).toBeTruthy()
    const unlockCalls = fetchMock.mock.calls.filter(
      ([url, init]) => url === '/api/vault/unlock' && init?.method === 'POST',
    )
    expect(unlockCalls).toHaveLength(2) // first refused, then retried automatically
  })

  it('imports a key and clears the secret from the form', async () => {
    let importBody: Record<string, unknown> | undefined
    backend({
      'GET /api/vault/status': () =>
        json(
          200,
          status({ unlocked: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }),
        ),
      'GET /api/addresses*': () =>
        json(200, {
          items: [
            {
              id: ADDRESS_ID,
              address: KEY.checksumAddress,
              label: 'Old wallet',
              network: { id: 'n1', name: 'sepolia', displayName: 'Sepolia' },
            },
          ],
          total: 1,
          page: 1,
          pageSize: 200,
        }),
      'POST /api/vault/keys': (body) => {
        importBody = body as Record<string, unknown>
        return json(201, { key: KEY })
      },
    })
    renderAt('/key-vault')
    const form = await screen.findByRole('form', { name: 'Import key' })
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: /Old wallet/ })).toBeTruthy(),
    )
    const input = within(form).getByLabelText('Private key (hex)') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: TEST_KEY } })
    fireEvent.click(within(form).getByRole('button', { name: 'Import' }))

    expect(await within(form).findByRole('status')).toBeTruthy()
    expect(importBody).toEqual({
      addressId: ADDRESS_ID,
      secretType: 'PRIVATE_KEY',
      secret: TEST_KEY,
      derivationPath: null,
    })
    expect((within(form).getByLabelText('Private key (hex)') as HTMLInputElement).value).toBe('')
  })

  it('retries an import exactly once after re-authentication (no nested-form double submit)', async () => {
    let attempts = 0
    backend({
      'GET /api/vault/status': () =>
        json(
          200,
          status({ unlocked: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }),
        ),
      'GET /api/addresses*': () =>
        json(200, {
          items: [
            {
              id: ADDRESS_ID,
              address: KEY.checksumAddress,
              label: 'Old wallet',
              network: { id: 'n1', name: 'sepolia', displayName: 'Sepolia' },
            },
          ],
          total: 1,
          page: 1,
          pageSize: 200,
        }),
      'POST /api/vault/keys': () =>
        ++attempts === 1
          ? json(403, { error: { code: 'REAUTH_REQUIRED', message: 'Please confirm' } })
          : json(201, { key: KEY }),
      'POST /api/auth/reauth': () => new Response(null, { status: 204 }),
    })
    renderAt('/key-vault')
    const form = await screen.findByRole('form', { name: 'Import key' })
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: /Old wallet/ })).toBeTruthy(),
    )
    fireEvent.change(within(form).getByLabelText('Private key (hex)'), {
      target: { value: TEST_KEY },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Import' }))
    const panel = await screen.findByRole('form', { name: 'Konfirmasi identitas' })
    fireEvent.change(within(panel).getByLabelText('Password akun'), {
      target: { value: 'correct horse battery' },
    })
    fireEvent.change(within(panel).getByLabelText('Kode authenticator'), {
      target: { value: '123456' },
    })
    fireEvent.click(within(panel).getByRole('button', { name: 'Konfirmasi' }))

    expect(await within(form).findByRole('status')).toBeTruthy()
    expect(attempts).toBe(2) // refused once, retried once — the confirm did not resubmit the form
  })

  it('after re-authentication, asks for a NEW code instead of retrying the reveal', async () => {
    const revealBodies: unknown[] = []
    backend({
      'GET /api/vault/status': () => json(200, status()),
      'GET /api/vault/keys': () => json(200, { keys: [KEY] }),
      'POST /api/vault/keys/reveal': (body) => {
        revealBodies.push(body)
        return revealBodies.length === 1
          ? json(403, { error: { code: 'REAUTH_REQUIRED', message: 'Please confirm' } })
          : json(200, { privateKey: TEST_KEY })
      },
      'POST /api/auth/reauth': () => new Response(null, { status: 204 }),
    })
    renderAt('/key-vault')
    fireEvent.click(await screen.findByRole('button', { name: 'Tampilkan key' }))
    const dialog = screen.getByRole('dialog', { name: 'Tampilkan private key' })
    fireEvent.change(within(dialog).getByLabelText('Passphrase vault'), {
      target: { value: 'marble orbit cactus lantern' },
    })
    const code = within(dialog).getByLabelText('Kode authenticator') as HTMLInputElement
    fireEvent.change(code, { target: { value: '111111' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tampilkan' }))

    const panel = await within(dialog).findByRole('form', { name: 'Konfirmasi identitas' })
    fireEvent.change(within(panel).getByLabelText('Password akun'), {
      target: { value: 'correct horse battery' },
    })
    fireEvent.change(within(panel).getByLabelText('Kode authenticator'), {
      target: { value: '111111' },
    })
    fireEvent.click(within(panel).getByRole('button', { name: 'Konfirmasi' }))

    expect((await within(dialog).findByRole('status')).textContent).toMatch(/kode authenticator/)
    expect(revealBodies).toHaveLength(1) // no automatic retry with the used-up code
    expect(code.value).toBe('')

    fireEvent.change(code, { target: { value: '222222' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tampilkan' }))
    expect(await within(dialog).findByLabelText('Private key')).toBeTruthy()
    expect(revealBodies[1]).toEqual({
      addressId: ADDRESS_ID,
      passphrase: 'marble orbit cactus lantern',
      code: '222222',
    })
  })

  it('reveals a key masked by default and closes itself after 60 seconds', async () => {
    // Fake timers from the start (the countdown interval must be created under them); real time still flows.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let revealBody: unknown
    backend({
      'GET /api/vault/status': () => json(200, status()),
      'GET /api/vault/keys': () => json(200, { keys: [KEY] }),
      'POST /api/vault/keys/reveal': (body) => {
        revealBody = body
        return json(200, { privateKey: TEST_KEY })
      },
    })
    renderAt('/key-vault')
    fireEvent.click(await screen.findByRole('button', { name: 'Tampilkan key' }))
    const dialog = screen.getByRole('dialog', { name: 'Tampilkan private key' })
    fireEvent.change(within(dialog).getByLabelText('Passphrase vault'), {
      target: { value: 'marble orbit cactus lantern' },
    })
    fireEvent.change(within(dialog).getByLabelText('Kode authenticator'), {
      target: { value: '654321' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tampilkan' }))

    const shown = await within(dialog).findByLabelText('Private key')
    expect(revealBody).toEqual({
      addressId: ADDRESS_ID,
      passphrase: 'marble orbit cactus lantern',
      code: '654321',
    })
    expect(shown.textContent).not.toContain(TEST_KEY) // masked until the user asks
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lihat' }))
    expect(within(dialog).getByLabelText('Private key').textContent).toBe(TEST_KEY)

    // Halfway through, the parent re-renders (keys list refetch): the timer must not restart.
    await act(async () => {
      vi.advanceTimersByTime(40_000)
    })
    window.dispatchEvent(new Event('focus'))
    await act(async () => {
      vi.advanceTimersByTime(21_000)
    })
    expect(screen.queryByRole('dialog', { name: 'Tampilkan private key' })).toBeNull()
    expect(document.body.textContent).not.toContain(TEST_KEY)
  })
})
