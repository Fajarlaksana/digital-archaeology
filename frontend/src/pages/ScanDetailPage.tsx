import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Badge, Button, ErrorMessage } from '../components/ui'
import { isScanRunning, scansApi, type ResultFilter } from '../services/api'
import { ActivityBadge, shortAddress } from './AddressesPage'
import { SCANS_KEY, ScanProgress, ScanStatusBadge } from './ScansPage'

const POLL_MS = 3000

const FILTERS: Array<{ value: ResultFilter; label: string }> = [
  { value: 'all', label: 'Semua' },
  { value: 'inactive', label: 'Tidak aktif' },
  { value: 'criteria', label: 'Sesuai kriteria' },
  { value: 'review', label: 'Perlu review' },
  { value: 'failed', label: 'Gagal' },
]

export function ScanDetailPage() {
  const { id = '' } = useParams()
  const [filter, setFilter] = useState<ResultFilter>('all')
  const [page, setPage] = useState(1)

  const scan = useQuery({
    queryKey: [...SCANS_KEY, id],
    queryFn: () => scansApi.get(id),
    refetchInterval: (query) =>
      query.state.data && isScanRunning(query.state.data) ? POLL_MS : false,
  })
  const running = scan.data ? isScanRunning(scan.data) : false
  const results = useQuery({
    queryKey: [...SCANS_KEY, id, 'results', filter, page],
    queryFn: () => scansApi.results(id, filter, page),
    placeholderData: keepPreviousData,
    refetchInterval: running ? POLL_MS : false,
  })
  const totalPages = Math.max(1, Math.ceil((results.data?.total ?? 0) / 50))
  const s = scan.data

  return (
    <section className="max-w-6xl">
      <Link to="/scans" className="text-sm text-slate-500 hover:text-slate-900">
        ← Scans
      </Link>
      <ErrorMessage error={scan.error} />
      {s && (
        <>
          <h1 className="mt-2 flex flex-wrap items-center gap-3 text-2xl font-semibold">
            Scan {s.network.displayName} <ScanStatusBadge status={s.status} />
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Tidak aktif jika tidak ada transaksi keluar ≥ {s.thresholdDays} hari
            {(s.minimumBalance || s.maximumBalance) &&
              ` · kriteria saldo ${s.minimumBalance ?? '0'} – ${s.maximumBalance ?? '∞'} ${s.network.nativeSymbol ?? ''}`}
          </p>
          {s.errorMessage && (
            <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {s.errorMessage}
            </p>
          )}
          <dl className="mt-4 grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase text-slate-500">Progres</dt>
              <dd className="mt-1">
                <ScanProgress scan={s} />
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-500">Tidak aktif</dt>
              <dd className="mt-1 text-lg font-semibold">{s.totalInactive}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-500">Gagal</dt>
              <dd className="mt-1 text-lg font-semibold">{s.totalFailed}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-500">Selesai</dt>
              <dd className="mt-1">
                {s.completedAt ? new Date(s.completedAt).toLocaleString('id-ID') : '—'}
              </dd>
            </div>
          </dl>
        </>
      )}

      <div role="tablist" aria-label="Filter hasil" className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => {
              setFilter(f.value)
              setPage(1)
            }}
            className={`rounded-full px-3 py-1 text-sm ${
              filter === f.value
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-700 ring-1 ring-slate-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ErrorMessage error={results.error} />
      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Address</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Hari tidak aktif</th>
              <th className="px-4 py-2">Saldo {s?.network.nativeSymbol}</th>
              <th className="px-4 py-2">Keluar terakhir</th>
              <th className="px-4 py-2">Tx masuk / keluar</th>
              <th className="px-4 py-2">Catatan</th>
            </tr>
          </thead>
          <tbody>
            {results.data?.items.map((r) => (
              <tr key={r.addressId} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2">
                  <Link
                    to={`/addresses/${r.addressId}`}
                    className="font-mono text-xs underline-offset-2 hover:underline"
                    title={r.address}
                  >
                    {shortAddress(r.address)}
                  </Link>
                  {r.label && <span className="block text-xs text-slate-500">{r.label}</span>}
                </td>
                <td className="px-4 py-2">
                  <ActivityBadge status={r.activityStatus} />
                </td>
                <td className="px-4 py-2">{r.inactiveDays ?? '—'}</td>
                <td className="px-4 py-2 font-mono text-xs">{r.nativeBalance ?? '—'}</td>
                <td className="px-4 py-2 text-xs">
                  {r.lastOutgoingAt
                    ? new Date(r.lastOutgoingAt).toLocaleDateString('id-ID')
                    : 'tidak pernah'}
                </td>
                <td className="px-4 py-2 text-xs">
                  {r.incomingTxCount ?? '—'} / {r.outgoingTxCount ?? '—'}
                </td>
                <td className="space-x-1 px-4 py-2">
                  {r.errorCode && <Badge tone="red">{r.errorCode}</Badge>}
                  {r.reviewFlag && <Badge tone="amber">perlu review</Badge>}
                  {r.matchesCriteria && <Badge tone="green">sesuai kriteria</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {results.data?.items.length === 0 && (
          <p className="p-4 text-sm text-slate-500">
            {running ? 'Menunggu hasil…' : 'Tidak ada hasil.'}
          </p>
        )}
      </div>

      <nav aria-label="Halaman" className="mt-3 flex items-center gap-3 text-sm text-slate-600">
        <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Sebelumnya
        </Button>
        <span>
          Halaman {page} / {totalPages} · {results.data?.total ?? 0} hasil
        </span>
        <Button variant="secondary" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
          Berikutnya
        </Button>
      </nav>
    </section>
  )
}
