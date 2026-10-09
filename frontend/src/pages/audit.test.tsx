import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import type { AuditEntry, PublicNetwork } from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const AUDITOR: Permission[] = ['users:read', 'audit:read', 'reports:read', 'networks:read']

const entry = (sequence: number, overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  sequence: String(sequence),
  createdAt: '2026-10-05T03:00:00.000Z',
  user: { id: 'u1', email: 'reviewer@dev.local', name: 'Rina' },
  action: 'TRANSACTION_APPROVED',
  result: 'SUCCESS',
  resourceType: 'transaction',
  resourceId: 'tx-1',
  ipAddress: '127.0.0.1',
  userAgent: 'test',
  requestId: 'req-1',
  metadata: { reason: 'Checked', password: '[REDACTED]' },
  hash: 'a'.repeat(64),
  prevHash: 'b'.repeat(64),
  ...overrides,
})

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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function auditBackend(routes: Record<string, (b: unknown) => Response> = {}) {
  return mockBackend({
    'GET /api/auth/me': () => json(200, session('AUDITOR', AUDITOR)),
    'GET /api/audit-logs/actions': () =>
      json(200, { actions: ['TRANSACTION_APPROVED', 'TX_SIGNED'] }),
    'GET /api/audit-logs': () => json(200, { items: [entry(12), entry(11)], nextBefore: '11' }),
    'GET /api/audit-logs?before=11': () =>
      json(200, { items: [entry(10, { action: 'TX_SIGNED' })], nextBefore: null }),
    ...routes,
  })
}

describe('Audit Logs', () => {
  it('lists entries, shows metadata on click, and loads older pages', async () => {
    auditBackend()
    renderAt('/audit-logs')
    expect((await screen.findAllByText('TRANSACTION_APPROVED')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByText('reviewer@dev.local')[0]!)
    expect(screen.getByLabelText('Metadata #12').textContent).toContain('[REDACTED]')
    fireEvent.click(screen.getByRole('button', { name: 'Muat lebih banyak' }))
    expect(await screen.findByText('10')).toBeTruthy()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Muat lebih banyak' })).toBeNull(),
    )
  })

  it('applies filters to the list and to the CSV link', async () => {
    const fetchMock = auditBackend({
      'GET /api/audit-logs*': () => json(200, { items: [], nextBefore: null }),
    })
    renderAt('/audit-logs')
    const form = await screen.findByRole('form', { name: 'Filter audit' })
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'TX_SIGNED' })).toBeTruthy(),
    )
    fireEvent.change(within(form).getByLabelText('Aksi'), { target: { value: 'TX_SIGNED' } })
    fireEvent.change(within(form).getByLabelText('Hasil'), { target: { value: 'DENIED' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Terapkan filter' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url) === '/api/audit-logs?action=TX_SIGNED&result=DENIED',
        ),
      ).toBe(true),
    )
    expect(screen.getByRole('link', { name: /Unduh CSV/ }).getAttribute('href')).toBe(
      '/api/reports/audit.csv?action=TX_SIGNED&result=DENIED',
    )
    expect(await screen.findByText(/Tidak ada entri/)).toBeTruthy()
  })

  it('verifies the hash chain and reports a break loudly', async () => {
    let ok = true
    auditBackend({
      'POST /api/audit-logs/verify': () =>
        json(
          200,
          ok
            ? {
                ok: true,
                checked: 120,
                firstBrokenSequence: null,
                reason: null,
                headSequence: '120',
                headHash: 'c'.repeat(64),
              }
            : {
                ok: false,
                checked: 120,
                firstBrokenSequence: '57',
                reason: 'ROW_MODIFIED',
                headSequence: '120',
                headHash: 'c'.repeat(64),
              },
        ),
    })
    renderAt('/audit-logs')
    fireEvent.click(await screen.findByRole('button', { name: 'Verifikasi integritas' }))
    expect((await screen.findByRole('status')).textContent).toMatch(/Rantai utuh: 120 baris/)
    expect(screen.getByText('c'.repeat(64))).toBeTruthy()
    ok = false
    fireEvent.click(screen.getByRole('button', { name: 'Verifikasi integritas' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(
        /RUSAK mulai baris #57 \(isi baris diubah\)/,
      ),
    )
  })

  it('records a periodic review up to the latest entry, and filters sensitive actions', async () => {
    let reviewed: unknown
    const fetchMock = auditBackend({
      'GET /api/audit-logs/reviews/status': () =>
        json(200, {
          lastReview: reviewed
            ? {
                at: '2026-10-09T02:00:00.000Z',
                by: { id: 'a1', email: 'auditor@dev.local', name: 'Audi' },
                upToSequence: '12',
                note: 'ok',
              }
            : null,
          sensitiveSince: reviewed ? 0 : 7,
          latestSequence: '12',
        }),
      'POST /api/audit-logs/reviews': (b) => {
        reviewed = b
        return json(200, {
          chain: {
            ok: true,
            checked: 12,
            firstBrokenSequence: null,
            reason: null,
            headSequence: '12',
            headHash: 'c'.repeat(64),
          },
          reviewedSensitive: 7,
        })
      },
      'GET /api/audit-logs*': () => json(200, { items: [], nextBefore: null }),
    })
    renderAt('/audit-logs')
    const panel = await screen.findByRole('region', { name: 'Review berkala' })
    expect(panel.textContent).toMatch(/Belum pernah ada review\. 7 aksi sensitif/)
    const form = within(panel).getByRole('form', { name: 'Tandai sudah direview' })
    const submit = within(form).getByRole('button', {
      name: 'Tandai sudah direview sampai #12',
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(within(form).getByLabelText(/^Catatan review/), {
      target: { value: 'Semua signing cocok dengan approval' },
    })
    fireEvent.click(submit)
    expect((await within(panel).findByRole('status')).textContent).toMatch(
      /7 aksi sensitif\). Rantai utuh/,
    )
    expect(reviewed).toEqual({ upToSequence: '12', note: 'Semua signing cocok dengan approval' })
    await waitFor(() =>
      expect(panel.textContent).toMatch(/Terakhir direview sampai #12 oleh auditor@dev\.local/),
    )

    const filter = screen.getByRole('form', { name: 'Filter audit' })
    fireEvent.click(within(filter).getByLabelText(/Aksi sensitif saja/))
    fireEvent.click(within(filter).getByRole('button', { name: 'Terapkan filter' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url) === '/api/audit-logs?category=sensitive'),
      ).toBe(true),
    )
  })

  it('is not reachable without audit:read', async () => {
    mockBackend({ 'GET /api/auth/me': () => json(200, session('ANALYST', ['addresses:read'])) })
    renderAt('/audit-logs')
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy()
  })
})

describe('Reports', () => {
  it('offers every SA 21 report, scoped by network and period; audit only for AUDITOR', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('AUDITOR', AUDITOR)),
      'GET /api/networks': () => json(200, { networks: [NETWORK] }),
    })
    renderAt('/reports')
    for (const title of [
      'Address Inventory',
      'Inactivity Report',
      'Balance Report',
      'Authorization Report',
      'Recovery Eligibility Report',
      'Transaction Report',
      'Audit Report',
    ]) {
      expect(await screen.findByRole('link', { name: `${title} (CSV)` })).toBeTruthy()
    }
    await waitFor(() => expect(screen.getByRole('option', { name: 'Sepolia' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Network'), { target: { value: 'net-1' } })
    expect(screen.getByRole('link', { name: 'Balance Report (CSV)' }).getAttribute('href')).toBe(
      '/api/reports/balances.csv?networkId=net-1',
    )
    fireEvent.change(screen.getByLabelText('Dari tanggal'), { target: { value: '2026-10-01' } })
    expect(
      screen.getByRole('link', { name: 'Transaction Report (CSV)' }).getAttribute('href'),
    ).toMatch(/^\/api\/reports\/transactions\.csv\?networkId=net-1&from=2026-\d\d-\d\dT/)
  })

  it('hides the audit report from users without audit:read', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('ANALYST', ['reports:read', 'networks:read'])),
      'GET /api/networks': () => json(200, { networks: [] }),
    })
    renderAt('/reports')
    expect(await screen.findByRole('link', { name: 'Balance Report (CSV)' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Audit Report (CSV)' })).toBeNull()
  })
})
