import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { Button, ErrorMessage } from '../components/ui'
import { RecoveryBadge, REASONS, reasonLabel } from '../eligibility'
import {
  addressesApi,
  eligibilityApi,
  formatFiat,
  networksApi,
  reportUrls,
  type RecoveryStatus,
} from '../services/api'
import { ADDRESSES_KEY, ActivityBadge } from './AddressesPage'
import { NETWORKS_KEY } from './NetworksPage'

const FILTERS: RecoveryStatus[] = ['READY', 'NOT_ECONOMIC', 'NOT_ELIGIBLE', 'NONE']

/**
 * Recovery eligibility overview (Phase 8b, ADR-021). READY is information for people: nothing is
 * moved automatically (CLAUDE.md rule 5). Transaction preview & approval arrive in Phase 9.
 */
export function RecoveryPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const networks = useQuery({ queryKey: NETWORKS_KEY, queryFn: networksApi.list })
  const config = useQuery({ queryKey: ['eligibility', 'config'], queryFn: eligibilityApi.config })
  const [networkId, setNetworkId] = useState('')
  const [status, setStatus] = useState<RecoveryStatus | ''>('')
  const selectedNetwork = networkId || networks.data?.[0]?.id || ''

  const list = useQuery({
    queryKey: [...ADDRESSES_KEY, 'recovery', selectedNetwork, status],
    queryFn: () =>
      addressesApi.list({
        networkId: selectedNetwork,
        recoveryStatus: status || undefined,
        pageSize: 200,
      }),
    enabled: selectedNetwork !== '',
  })

  const evaluate = useMutation({
    mutationFn: (id: string) => eligibilityApi.evaluate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADDRESSES_KEY }),
  })

  const c = config.data
  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">Recovery</h1>
      <p className="mt-1 text-sm text-slate-600">
        Kelayakan recovery tiap address. Status <strong>READY</strong> hanya informasi: tidak ada
        aset yang dipindahkan otomatis. Preview dan approval transaksi tersedia di Fase 9.
      </p>
      {c && (
        <p className="mt-2 text-xs text-slate-500">
          Aturan: nilai bersih minimum {formatFiat(c.minNetValue, c.fiatCurrency)} setelah fee ·
          margin fee {c.feeMarginPercent}% · saldo maksimal {c.balanceMaxAgeHours} jam sejak scan.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Network</span>
          <select
            className="mt-1 block rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={selectedNetwork}
            onChange={(e) => setNetworkId(e.target.value)}
          >
            {networks.data?.map((n) => (
              <option key={n.id} value={n.id}>
                {n.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Status kelayakan</span>
          <select
            className="mt-1 block rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as RecoveryStatus | '')}
          >
            <option value="">Semua</option>
            {FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === 'NONE' ? 'Belum dinilai' : s}
              </option>
            ))}
          </select>
        </label>
        {can('scans:run') && (
          <Button
            disabled={!selectedNetwork || evaluate.isPending}
            onClick={() => evaluate.mutate(selectedNetwork)}
          >
            {evaluate.isPending ? 'Menghitung…' : 'Hitung ulang'}
          </Button>
        )}
        {can('reports:read') && (
          <a href={reportUrls.eligibility} className="text-sm underline" download>
            Unduh laporan kelayakan (CSV)
          </a>
        )}
      </div>
      <ErrorMessage error={evaluate.error} />
      {evaluate.data && (
        <p role="status" className="mt-3 rounded-md bg-slate-100 px-3 py-2 text-sm">
          {evaluate.data.evaluated} address dinilai: {evaluate.data.ready} READY,{' '}
          {evaluate.data.notEconomic} NOT_ECONOMIC, {evaluate.data.notEligible} NOT_ELIGIBLE.
          {evaluate.data.feeError && ` Fee tidak bisa dibaca (${evaluate.data.feeError}).`}
        </p>
      )}

      <ErrorMessage error={list.error} />
      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Address</th>
              <th className="px-4 py-2">Kelayakan</th>
              <th className="px-4 py-2">Alasan / tindakan</th>
              <th className="px-4 py-2">Aktivitas</th>
              <th className="px-4 py-2">Dinilai</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((a) => (
              <tr key={a.id} className="border-b border-slate-100 align-top last:border-0">
                <td className="px-4 py-2">
                  <Link
                    to={`/addresses/${a.id}`}
                    className="font-mono text-xs underline-offset-2 hover:underline"
                    title={a.address}
                  >
                    {a.label ?? `${a.address.slice(0, 10)}…`}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <RecoveryBadge status={a.recoveryStatus} />
                </td>
                <td className="px-4 py-2 text-xs">
                  {a.recoveryReasons.length === 0
                    ? '—'
                    : a.recoveryReasons.map((code) => (
                        <div key={code}>
                          <span className="font-medium">{reasonLabel(code)}</span>
                          {REASONS[code] && (
                            <span className="text-slate-500"> — {REASONS[code].action}</span>
                          )}
                        </div>
                      ))}
                </td>
                <td className="px-4 py-2">
                  <ActivityBadge status={a.activityStatus} />
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">
                  {a.eligibilityCheckedAt
                    ? new Date(a.eligibilityCheckedAt).toLocaleString('id-ID')
                    : 'Belum'}
                </td>
              </tr>
            ))}
            {list.data?.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  Tidak ada address untuk filter ini.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
