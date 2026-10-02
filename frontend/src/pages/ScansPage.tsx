import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { Badge, Button, ErrorMessage, Field } from '../components/ui'
import {
  isScanRunning,
  networksApi,
  scansApi,
  type PublicScan,
  type ScanStatus,
} from '../services/api'
import { NETWORKS_KEY } from './NetworksPage'

export const SCANS_KEY = ['scans'] as const
const POLL_MS = 3000

export function ScanStatusBadge({ status }: { status: ScanStatus }) {
  const tone =
    status === 'COMPLETED'
      ? 'green'
      : status === 'FAILED'
        ? 'red'
        : status === 'RUNNING'
          ? 'blue'
          : 'slate'
  return <Badge tone={tone}>{status}</Badge>
}

export function ScanProgress({ scan }: { scan: PublicScan }) {
  const pct =
    scan.totalAddresses === 0
      ? 100
      : Math.round((scan.processedAddresses / scan.totalAddresses) * 100)
  return (
    <div className="min-w-32">
      <div
        className="h-1.5 rounded bg-slate-200"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progres scan"
      >
        <div className="h-1.5 rounded bg-slate-900" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {scan.processedAddresses} / {scan.totalAddresses} address
      </p>
    </div>
  )
}

export function ScansPage() {
  const { can } = useAuth()
  const scans = useQuery({
    queryKey: SCANS_KEY,
    queryFn: () => scansApi.list(),
    // Keep polling while any scan is still working.
    refetchInterval: (query) => (query.state.data?.items.some(isScanRunning) ? POLL_MS : false),
  })

  return (
    <section className="max-w-6xl">
      <h1 className="text-2xl font-semibold">Scans</h1>
      <p className="mt-1 text-slate-600">
        Membaca saldo dan aktivitas address yang terdaftar langsung dari blockchain. Address yang
        diarsipkan tidak ikut di-scan. Ketidakaktifan dihitung dari{' '}
        <strong>transaksi keluar</strong> terakhir, jadi token spam yang masuk tidak membuat wallet
        terlihat aktif.
      </p>

      {can('scans:run') && <NewScanForm />}

      <ErrorMessage error={scans.error} />
      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Dibuat</th>
              <th className="px-4 py-2">Network</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Progres</th>
              <th className="px-4 py-2">Tidak aktif</th>
              <th className="px-4 py-2">Gagal</th>
            </tr>
          </thead>
          <tbody>
            {scans.data?.items.map((scan) => (
              <tr key={scan.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2">
                  <Link to={`/scans/${scan.id}`} className="underline-offset-2 hover:underline">
                    {new Date(scan.createdAt).toLocaleString('id-ID')}
                  </Link>
                </td>
                <td className="px-4 py-2">{scan.network.displayName}</td>
                <td className="px-4 py-2">
                  <ScanStatusBadge status={scan.status} />
                </td>
                <td className="px-4 py-2">
                  <ScanProgress scan={scan} />
                </td>
                <td className="px-4 py-2">{scan.totalInactive}</td>
                <td className="px-4 py-2">{scan.totalFailed}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {scans.data?.items.length === 0 && (
          <p className="p-4 text-sm text-slate-500">Belum ada scan.</p>
        )}
      </div>
    </section>
  )
}

function NewScanForm() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const networks = useQuery({ queryKey: NETWORKS_KEY, queryFn: networksApi.list })
  const active = networks.data?.filter((n) => n.status === 'ACTIVE') ?? []
  const [form, setForm] = useState({ networkId: '', thresholdDays: '730', min: '', max: '' })
  const networkId = form.networkId || active[0]?.id || ''
  const selected = active.find((n) => n.id === networkId)
  const native = selected?.assets.find((a) => a.isNative)?.symbol ?? ''

  const start = useMutation({
    mutationFn: () =>
      scansApi.create({
        networkId,
        thresholdDays: Number(form.thresholdDays),
        minimumBalance: form.min.trim() || null,
        maximumBalance: form.max.trim() || null,
      }),
    onSuccess: async (scan) => {
      await queryClient.invalidateQueries({ queryKey: SCANS_KEY })
      navigate(`/scans/${scan.id}`)
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    start.mutate()
  }

  return (
    <form
      aria-label="Scan baru"
      onSubmit={onSubmit}
      className="mt-4 grid max-w-3xl gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-4"
    >
      <label className="text-sm sm:col-span-4">
        <span className="block font-medium text-slate-700">Network</span>
        <select
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
          value={networkId}
          onChange={(e) => setForm({ ...form, networkId: e.target.value })}
        >
          {active.map((n) => (
            <option key={n.id} value={n.id}>
              {n.displayName}
              {n.rpcConfigured ? '' : ' — RPC belum dikonfigurasi'}
            </option>
          ))}
        </select>
      </label>
      <Field
        label="Tidak aktif ≥ (hari)"
        type="number"
        min={1}
        required
        value={form.thresholdDays}
        onChange={(e) => setForm({ ...form, thresholdDays: e.target.value })}
      />
      <Field
        label={`Saldo minimum ${native}`}
        inputMode="decimal"
        placeholder="opsional"
        value={form.min}
        onChange={(e) => setForm({ ...form, min: e.target.value })}
      />
      <Field
        label={`Saldo maksimum ${native}`}
        inputMode="decimal"
        placeholder="opsional"
        value={form.max}
        onChange={(e) => setForm({ ...form, max: e.target.value })}
      />
      <div className="flex items-end">
        <Button type="submit" disabled={start.isPending || !networkId} className="w-full">
          Mulai scan
        </Button>
      </div>
      <div className="sm:col-span-4">
        <ErrorMessage error={start.error} />
      </div>
    </form>
  )
}
