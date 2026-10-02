import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Permission } from '@da/shared/rbac'
import { formatFiat, type DashboardSummary } from '../services/api'
import { json, mockBackend, renderAt, session } from '../test-utils'

const AUDITOR: Permission[] = [
  'networks:read',
  'addresses:read',
  'scans:read',
  'reports:read',
  'audit:read',
]

function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    fiatCurrency: 'USD',
    networkId: null,
    addresses: {
      total: 12,
      active: 3,
      inactive: 7,
      unscanned: 2,
      withBalance: 6,
      verified: 0,
      needsReview: 1,
    },
    inactiveValue: {
      value: '0.00',
      simulatedValue: '15000.50',
      oldestPriceAt: '2026-10-03T00:00:00.000Z',
      priceSource: 'coingecko',
    },
    totalValue: {
      value: '0.00',
      simulatedValue: '20000.00',
      oldestPriceAt: null,
      priceSource: null,
    },
    transactions: { pending: 0, completed: 0 },
    networks: [
      {
        id: 'n1',
        name: 'sepolia',
        displayName: 'Ethereum Sepolia (testnet)',
        isTestnet: true,
        lastScan: {
          id: 's1',
          status: 'COMPLETED',
          trigger: 'SCHEDULED',
          createdAt: '2026-10-03T02:00:00.000Z',
          completedAt: '2026-10-03T02:01:00.000Z',
        },
      },
    ],
    recentScans: [],
    schedule: {
      scansEnabled: true,
      scanPattern: '0 2 * * *',
      timezone: 'Asia/Jakarta',
      nextScanAt: '2026-10-04T02:00:00.000Z',
      priceIntervalMinutes: 60,
    },
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('formatFiat', () => {
  it.each([
    ['1250.25', 'USD', '$1,250.25'],
    ['1250.25000000', 'USD', '$1,250.25'],
    ['1234567.5', 'USD', '$1,234,567.50'],
    ['0.00000001', 'USD', '$0.00000001'],
    ['0.00', 'USD', '$0.00'],
    ['15000000.75', 'IDR', 'Rp15.000.000,75'],
    [null, 'USD', '—'],
    [undefined, 'USD', '—'],
  ])('%s %s → %s', (value, currency, expected) => {
    expect(formatFiat(value, currency)).toBe(expected)
  })

  it('keeps every digit of huge values (no float rounding)', () => {
    expect(formatFiat('123456789012345678901.23', 'USD')).toBe('$123,456,789,012,345,678,901.23')
  })
})

describe('Dashboard', () => {
  it('shows counts, separates simulated testnet value from real value, and the schedule', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('AUDITOR', AUDITOR)),
      'GET /api/dashboard': () => json(200, summary()),
    })
    renderAt('/')

    expect(await screen.findByText('Address terdaftar')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()

    const inactive = screen.getByRole('region', { name: 'Estimasi nilai address tidak aktif' })
    expect(within(inactive).getByText('$0.00')).toBeTruthy() // real money
    expect(within(inactive).getByText('SIMULASI')).toBeTruthy()
    expect(within(inactive).getByText(/\$15,000\.50 dari aset testnet/)).toBeTruthy()

    expect(screen.getByText(/Scan otomatis: 0 2 \* \* \* \(Asia\/Jakarta\)/)).toBeTruthy()
    expect(screen.getByText('(terjadwal)')).toBeTruthy()
  })

  it('tells the user when there are no prices yet', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('AUDITOR', AUDITOR)),
      'GET /api/dashboard': () =>
        json(
          200,
          summary({
            inactiveValue: {
              value: '0.00',
              simulatedValue: '0.00',
              oldestPriceAt: null,
              priceSource: null,
            },
          }),
        ),
    })
    renderAt('/')
    const inactive = await screen.findByRole('region', {
      name: 'Estimasi nilai address tidak aktif',
    })
    expect(within(inactive).getByText(/Belum ada harga/)).toBeTruthy()
    expect(within(inactive).queryByText('SIMULASI')).toBeNull()
  })
})

describe('CSV export links', () => {
  it('are offered to roles with reports:read', async () => {
    mockBackend({
      'GET /api/auth/me': () => json(200, session('AUDITOR', AUDITOR)),
      'GET /api/networks': () => json(200, { networks: [] }),
      'GET /api/addresses*': () => json(200, { items: [], total: 0, page: 1, pageSize: 50 }),
    })
    renderAt('/addresses')
    const link = await screen.findByRole('link', { name: 'Export tidak aktif (CSV)' })
    expect(link.getAttribute('href')).toBe('/api/reports/addresses.csv?type=inactivity')
    expect(screen.getByRole('link', { name: 'Export inventaris (CSV)' })).toBeTruthy()
  })
})
