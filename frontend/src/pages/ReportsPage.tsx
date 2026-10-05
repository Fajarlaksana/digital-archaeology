import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../auth/useAuth'
import { auditApi, networksApi, reportUrls } from '../services/api'
import { NETWORKS_KEY } from './NetworksPage'
import { dayBound } from '../lib/dates'

/** All SA 21 reports in one place (Phase 12, ADR-025). Every export is audited. */
export function ReportsPage() {
  const { can } = useAuth()
  const networks = useQuery({ queryKey: NETWORKS_KEY, queryFn: networksApi.list })
  const [networkId, setNetworkId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const net = networkId || undefined
  const period = { from: dayBound(from), to: dayBound(to, true) }

  const reports: Array<{ title: string; description: string; href: string; scoped?: string }> = [
    {
      title: 'Address Inventory',
      description: 'Semua address aktif per aset: data chain, estimasi nilai, status.',
      href: reportUrls.inventory,
    },
    {
      title: 'Inactivity Report',
      description: 'Hanya address INACTIVE.',
      href: reportUrls.inactivity,
    },
    {
      title: 'Balance Report',
      description: 'Saldo per aset (chain_*) dan estimasi nilai (estimate_*, testnet = simulasi).',
      href: reportUrls.balances(net),
      scoped: 'network',
    },
    {
      title: 'Authorization Report',
      description: 'Dasar otorisasi, sidik jari dokumen, dan hasil challenge terakhir (auth_*).',
      href: reportUrls.authorizations(net),
      scoped: 'network',
    },
    {
      title: 'Recovery Eligibility Report',
      description: 'Status kelayakan per aset, fee estimasi, nilai bersih, alasan.',
      href: reportUrls.eligibility,
    },
    {
      title: 'Transaction Report',
      description:
        'Preview sampai konfirmasi: pembuat, approver, hash, fee maks vs aktual, explorer.',
      href: reportUrls.transactions({ networkId: net, ...period }),
      scoped: 'network + periode',
    },
  ]
  if (can('audit:read')) {
    reports.push({
      title: 'Audit Report',
      description: 'Seluruh jejak audit dengan hash chain (khusus AUDITOR).',
      href: auditApi.csvUrl(period),
      scoped: 'periode',
    })
  }

  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">Reports</h1>
      <p className="mt-1 text-sm text-slate-600">
        Laporan CSV (aman dibuka di spreadsheet). Awalan kolom memisahkan jenis data:{' '}
        <code>chain_</code> data blockchain publik, <code>estimate_</code> estimasi nilai,{' '}
        <code>auth_</code> data otorisasi, <code>status_</code> status internal. Setiap unduhan
        tercatat di audit log.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-4 rounded-lg border border-slate-200 bg-white p-4">
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Network</span>
          <select
            className="mt-1 block rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={networkId}
            onChange={(e) => setNetworkId(e.target.value)}
          >
            <option value="">Semua</option>
            {networks.data?.map((n) => (
              <option key={n.id} value={n.id}>
                {n.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Dari tanggal</span>
          <input
            type="date"
            className="mt-1 block rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Sampai tanggal</span>
          <input
            type="date"
            className="mt-1 block rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>

      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {reports.map((r) => (
          <li key={r.title} className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <a href={r.href} download className="font-semibold underline-offset-2 hover:underline">
              {r.title} (CSV)
            </a>
            <p className="mt-1 text-slate-600">{r.description}</p>
            {r.scoped && <p className="mt-1 text-xs text-slate-500">Filter: {r.scoped}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}
