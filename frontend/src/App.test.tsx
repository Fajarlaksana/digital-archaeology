import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type { Me, SessionState } from './services/api'
import { json, mockBackend, renderAt, session, user } from './test-utils'

const PERMS: Record<'ANALYST' | 'ADMIN', Permission[]> = {
  ANALYST: [
    'networks:read',
    'addresses:read',
    'addresses:manage',
    'scans:read',
    'scans:run',
    'reports:read',
  ],
  ADMIN: ['networks:read', 'networks:manage', 'users:read', 'users:manage', 'reports:read'],
}

function me(role: 'ANALYST' | 'ADMIN', sessionState: SessionState = 'ACTIVE'): Me {
  return session(role, PERMS[role], sessionState)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('authentication flow', () => {
  it('sends anonymous visitors to the login page', async () => {
    mockBackend({ 'GET /api/auth/me': () => json(401, { error: { code: 'UNAUTHORIZED' } }) })
    renderAt('/scans')
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeTruthy()
  })

  it('shows the backend error message on failed login', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(401, { error: { code: 'UNAUTHORIZED' } }),
      'POST /api/auth/login': () =>
        json(401, {
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'Invalid email or password',
            request_id: 'req-1',
          },
        }),
    })
    renderAt('/login')
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.c' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Masuk' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Invalid email or password')
    expect(alert.textContent).toContain('req-1')
  })

  it('sends a session that still needs MFA to the MFA page', async () => {
    mockBackend({ 'GET /api/auth/me': () => json(200, me('ADMIN', 'MFA_PENDING')) })
    renderAt('/')
    expect(await screen.findByRole('heading', { name: 'Verifikasi dua langkah' })).toBeTruthy()
    expect(screen.getByLabelText('Kode 6 digit dari aplikasi authenticator')).toBeTruthy()
  })

  it('offers enrolment when MFA setup is required', async () => {
    mockBackend({ 'GET /api/auth/me': () => json(200, me('ADMIN', 'MFA_SETUP_REQUIRED')) })
    renderAt('/')
    expect(
      await screen.findByRole('heading', { name: 'Aktifkan verifikasi dua langkah' }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mulai setup' })).toBeTruthy()
  })
})

describe('permission-aware navigation', () => {
  it('shows an ANALYST only the pages it may open', async () => {
    mockBackend({ 'GET /api/auth/me': () => json(200, me('ANALYST')) })
    renderAt('/')
    const nav = await screen.findByRole('navigation', { name: 'Menu utama' })
    for (const label of ['Dashboard', 'Addresses', 'Scans', 'Reports']) {
      expect(within(nav).getByRole('link', { name: label })).toBeTruthy()
    }
    for (const label of ['Users', 'Key Vault', 'Signing', 'Audit Logs', 'Settings']) {
      expect(within(nav).queryByRole('link', { name: label })).toBeNull()
    }
    expect(screen.queryByText('Super Admin')).toBeNull()
  })

  it('redirects a direct URL to a forbidden page back to the dashboard', async () => {
    mockBackend({ 'GET /api/auth/me': () => json(200, me('ANALYST')) })
    renderAt('/key-vault')
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy()
  })

  it('renders the phase placeholder for a permitted page', async () => {
    mockBackend({ 'GET /api/auth/me': () => json(200, me('ANALYST')) })
    renderAt('/reports')
    expect(await screen.findByText('Halaman ini dibangun di Fase 12.')).toBeTruthy()
  })
})

describe('Users page', () => {
  it('lists users and never offers SUPER_ADMIN as a grantable role', async () => {
    const current = me('ADMIN')
    mockBackend({
      'GET /api/auth/me': () => json(200, current),
      'GET /api/users': () =>
        json(200, {
          users: [current.user, user(['SUPER_ADMIN'], { mfaEnabled: true }), user(['ANALYST'])],
        }),
    })
    renderAt('/users')

    expect(await screen.findByText('super_admin@dev.local')).toBeTruthy()
    expect(screen.getByText('Hanya lewat CLI server')).toBeTruthy()
    expect(screen.getByText('Tidak bisa mengubah akun sendiri')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Tambah user' }))
    const form = screen.getByRole('form', { name: 'Tambah user' })
    expect(within(form).getByLabelText('ANALYST')).toBeTruthy()
    expect(within(form).queryByLabelText('SUPER_ADMIN')).toBeNull()
  })
})

describe('dashboard', () => {
  it('shows system health', async () => {
    mockBackend({ 'GET /api/auth/me': () => json(200, me('ANALYST')) })
    renderAt('/')
    expect(await screen.findAllByText('ok')).toHaveLength(3)
  })
})
