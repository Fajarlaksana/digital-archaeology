import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { NAV_ITEMS } from './navigation'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App layout', () => {
  it('shows every menu item from system_analysis section 14 plus the vault pages', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: 'Menu utama' })
    for (const item of NAV_ITEMS) {
      expect(within(nav).getByRole('link', { name: item.label })).toBeTruthy()
    }
  })

  it('renders a placeholder that names the building phase', () => {
    renderAt('/key-vault')
    expect(screen.getByRole('heading', { name: 'Key Vault' })).toBeTruthy()
    expect(screen.getByText('Halaman ini dibangun di Fase 7.')).toBeTruthy()
  })

  it('shows backend health on the dashboard', async () => {
    renderAt('/')
    expect(await screen.findAllByText('ok')).toHaveLength(3)
  })
})
