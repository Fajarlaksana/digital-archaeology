/** Sidebar menu, from system_analysis section 14 plus the vault pages (ADR-003). */
export interface NavItem {
  path: string
  label: string
  /** Roadmap phase that builds this page (docs/03-roadmap.md). */
  phase: number
  description: string
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
        label: 'Networks',
        phase: 4,
        description: 'Daftar network blockchain yang didukung.',
      },
      {
        path: '/addresses',
        label: 'Addresses',
        phase: 4,
        description: 'Inventaris address milik sendiri / terotorisasi.',
      },
      {
        path: '/scans',
        label: 'Scans',
        phase: 5,
        description: 'Pemindaian saldo dan aktivitas address.',
      },
      {
        path: '/authorizations',
        label: 'Authorizations',
        phase: 7,
        description: 'Verifikasi kepemilikan & dokumen otorisasi.',
      },
      {
        path: '/recovery',
        label: 'Recovery',
        phase: 9,
        description: 'Kelayakan, preview, dan approval transaksi.',
      },
      {
        path: '/transactions',
        label: 'Transactions',
        phase: 11,
        description: 'Status broadcast dan konfirmasi transaksi.',
      },
      {
        path: '/reports',
        label: 'Reports',
        phase: 12,
        description: 'Laporan inventaris, aktivitas, dan transaksi.',
      },
      {
        path: '/audit-logs',
        label: 'Audit Logs',
        phase: 12,
        description: 'Jejak seluruh aktivitas (read-only).',
      },
      {
        path: '/settings',
        label: 'Settings',
        phase: 8,
        description: 'Aset, destination whitelist, dan scheduler.',
      },
    ],
  },
  {
    title: 'Super Admin',
    items: [
      {
        path: '/key-vault',
        label: 'Key Vault',
        phase: 7,
        description: 'Penyimpanan private key terenkripsi.',
      },
      {
        path: '/signing',
        label: 'Signing',
        phase: 10,
        description: 'Menandatangani transaksi yang sudah di-approve.',
      },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)
