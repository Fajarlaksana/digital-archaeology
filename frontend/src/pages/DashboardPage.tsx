import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Badge, ErrorMessage } from '../components/ui'
import {
  checkHealth,
  dashboardApi,
  formatFiat,
  type DashboardSummary,
  type HealthState,
  type ValueBlock,
} from '../services/api'
import { ScanStatusBadge } from './ScansPage'

const CHECKS = [
  { path: '/health', label: 'Backend' },
  { path: '/health/database', label: 'Database' },
  { path: '/health/rpc', label: 'RPC' },
] as const

type Results = Partial<Record<(typeof CHECKS)[number]['path'], HealthState>>

export function DashboardPage() {
  const summary = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => dashboardApi.summary(),
    refetchInterval: 30_000,
  })
  const d = summary.data

  return (
    <section className="max-w-6xl">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-1 text-slate-600">
        Ringkasan inventaris. Nilai fiat adalah <strong>estimasi</strong>, bukan dasar kepemilikan.
      </p>
      <ErrorMessage error={summary.error} />

      {d && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card
              label="Address terdaftar"
              value={d.addresses.total}
              hint={`${d.addresses.unscanned} belum di-scan`}
            />
            <Card
              label="Tidak aktif"
              value={d.addresses.inactive}
              hint={`${d.addresses.active} aktif · ${d.addresses.needsReview} perlu review`}
              tone="amber"
            />
            <Card label="Terverifikasi" value={d.addresses.verified} hint="kepemilikan (Fase 7)" />
            <Card
              label="Transaksi"
              value={d.transactions.pending}
              hint={`pending · ${d.transactions.completed} selesai`}
            />
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <ValueCard
              title="Estimasi nilai address tidak aktif"
              block={d.inactiveValue}
              currency={d.fiatCurrency}
            />
            <ValueCard
              title="Estimasi nilai seluruh inventaris"
              block={d.totalValue}
              currency={d.fiatCurrency}
            />
          </div>

          <ScanOverview summary={d} />
        </>
      )}

      <SystemHealth />
    </section>
  )
}

function Card({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: ReactNode
  hint?: string
  tone?: 'amber'
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone === 'amber' ? 'text-amber-700' : ''}`}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

function ValueCard({
  title,
  block,
  currency,
}: {
  title: string
  block: ValueBlock
  currency: string
}) {
  const hasSimulated = block.simulatedValue !== '0.00'
  return (
    <section aria-label={title} className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase text-slate-500">{title}</p>
      <p className="mt-1 text-2xl font-semibold">{formatFiat(block.value, currency)}</p>
      {hasSimulated && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <Badge tone="amber">SIMULASI</Badge>
          {formatFiat(block.simulatedValue, currency)} dari aset testnet (dihargai seperti mainnet,
          tidak bernilai nyata)
        </p>
      )}
      <p className="mt-2 text-xs text-slate-500">
        {block.oldestPriceAt
          ? `Harga ${block.priceSource ?? ''}, paling lama per ${new Date(block.oldestPriceAt).toLocaleString('id-ID')}`
          : 'Belum ada harga — perbarui harga di menu Networks.'}
      </p>
    </section>
  )
}

function ScanOverview({ summary }: { summary: DashboardSummary }) {
  const schedule = summary.schedule
  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Scan per network</h2>
        <p className="text-xs text-slate-500">
          {schedule === null
            ? 'Penjadwal tidak aktif'
            : schedule.scansEnabled
              ? `Scan otomatis: ${schedule.scanPattern} (${schedule.timezone})${
                  schedule.nextScanAt
                    ? ` · berikutnya ${new Date(schedule.nextScanAt).toLocaleString('id-ID')}`
                    : ''
                } · harga tiap ${schedule.priceIntervalMinutes} menit`
              : `Scan otomatis mati · harga tiap ${schedule.priceIntervalMinutes} menit`}
        </p>
      </div>
      <table className="mt-3 w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr>
            <th className="py-1">Network</th>
            <th className="py-1">Scan terakhir</th>
            <th className="py-1">Status</th>
          </tr>
        </thead>
        <tbody>
          {summary.networks.map((n) => (
            <tr key={n.id} className="border-t border-slate-100">
              <td className="py-1.5">
                {n.displayName} {n.isTestnet && <Badge tone="blue">testnet</Badge>}
              </td>
              <td className="py-1.5">
                {n.lastScan ? (
                  <Link
                    to={`/scans/${n.lastScan.id}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {new Date(n.lastScan.createdAt).toLocaleString('id-ID')}
                  </Link>
                ) : (
                  'Belum pernah'
                )}
                {n.lastScan?.trigger === 'SCHEDULED' && (
                  <span className="ml-2 text-xs text-slate-500">(terjadwal)</span>
                )}
              </td>
              <td className="py-1.5">
                {n.lastScan ? <ScanStatusBadge status={n.lastScan.status} /> : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function SystemHealth() {
  const [results, setResults] = useState<Results>({})

  useEffect(() => {
    let cancelled = false
    for (const check of CHECKS) {
      void checkHealth(check.path).then((state) => {
        if (!cancelled) setResults((prev) => ({ ...prev, [check.path]: state }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section aria-label="Status sistem" className="mt-6">
      <h2 className="text-sm font-semibold text-slate-700">Status sistem</h2>
      <ul className="mt-2 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
        {CHECKS.map((check) => {
          const state = results[check.path]
          const tone = !state
            ? 'border-slate-200 text-slate-500'
            : state.ok
              ? 'border-emerald-300 text-emerald-700'
              : 'border-amber-300 text-amber-700'
          return (
            <li key={check.path} className={`rounded-lg border bg-white p-3 ${tone}`}>
              <p className="text-sm font-medium text-slate-900">{check.label}</p>
              <p className="mt-1 text-sm">{state ? state.detail : 'memeriksa…'}</p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
