import type { Permission } from '@da/shared/rbac'

/** Sidebar menu, from system_analysis section 14 plus the vault pages (ADR-003). */
export interface NavItem {
  path: string
  label: string
  /** Roadmap phase that builds this page (docs/03-roadmap.md). */
  phase: number
  description: string
  /** Hidden from users without it. The backend enforces the same permission on its endpoints. */
  permission?: Permission
}

export interface NavGroup {
  title: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Operasional',
    items: [
      {
        path: '/',
        label: 'Dashboard',
        phase: 6,
        description: 'Ringkasan aset, status scan, dan transaksi.',
      },
      {
        path: '/networks',
        permission: 'networks:read',
        label: 'Networks',
        phase: 4,
        description: 'Daftar network blockchain yang didukung.',
      },
      {
        path: '/addresses',
        permission: 'addresses:read',
        label: 'Addresses',
        phase: 4,
        description: 'Inventaris address milik sendiri / terotorisasi.',
      },
      {
        path: '/scans',
        permission: 'scans:read',
        label: 'Scans',
        phase: 5,
        description: 'Pemindaian saldo dan aktivitas address.',
      },
      {
        path: '/authorizations',
        permission: 'authorizations:read',
        label: 'Authorizations',
        phase: 7,
        description: 'Verifikasi kepemilikan & dokumen otorisasi.',
      },
      {
        path: '/destinations',
        permission: 'destinations:read',
        label: 'Destinations',
        phase: 8,
        description: 'Wallet tujuan yang sudah dibuktikan dan di-approve.',
      },
      {
        path: '/recovery',
        permission: 'transactions:read',
        label: 'Recovery',
        phase: 8,
        description: 'Kelayakan recovery (Fase 8); preview & approval transaksi (Fase 9).',
      },
      {
        path: '/transactions',
        permission: 'transactions:read',
        label: 'Transactions',
        phase: 9,
        description: 'Preview & approval (Fase 9); signing, broadcast, konfirmasi (Fase 10–11).',
      },
      {
        path: '/reports',
        permission: 'reports:read',
        label: 'Reports',
        phase: 12,
        description: 'Laporan inventaris, aktivitas, dan transaksi.',
      },
      {
        path: '/audit-logs',
        permission: 'audit:read',
        label: 'Audit Logs',
        phase: 12,
        description: 'Jejak seluruh aktivitas (read-only).',
      },
      {
        path: '/settings',
        permission: 'networks:manage',
        label: 'Settings',
        phase: 8,
        description: 'Aset dan scheduler.',
      },
      {
        path: '/users',
        label: 'Users',
        phase: 3,
        permission: 'users:read',
        description: 'Akun pengguna, role, dan status.',
      },
    ],
  },
  {
    title: 'Super Admin',
    items: [
      {
        path: '/key-vault',
        permission: 'vault:manage',
        label: 'Key Vault',
        phase: 7,
        description: 'Penyimpanan private key terenkripsi.',
      },
      {
        path: '/signing',
        permission: 'transactions:sign',
        label: 'Signing',
        phase: 10,
        description: 'Menandatangani transaksi yang sudah di-approve.',
      },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)
