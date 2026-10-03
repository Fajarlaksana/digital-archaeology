import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { Badge, Button, ErrorMessage, Field } from '../components/ui'
import { addressesApi, formatFiat, scansApi, type PublicAddress } from '../services/api'
import { ADDRESSES_KEY, ActivityBadge } from './AddressesPage'
import { OwnershipSection } from './OwnershipSection'

export function AddressDetailPage() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const query = useQuery({
    queryKey: [...ADDRESSES_KEY, 'detail', id],
    queryFn: () => addressesApi.get(id),
  })

  return (
    <section className="max-w-4xl">
      <Link to="/addresses" className="text-sm text-slate-500 hover:text-slate-900">
        ← Addresses
      </Link>
      <ErrorMessage error={query.error} />
      {query.data && <Detail address={query.data} canManage={can('addresses:manage')} />}
    </section>
  )
}

function Detail({ address: a, canManage }: { address: PublicAddress; canManage: boolean }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ label: a.label ?? '', ownerReference: a.ownerReference })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ADDRESSES_KEY })

  const save = useMutation({
    mutationFn: () =>
      addressesApi.update(a.id, {
        label: form.label.trim() || null,
        ownerReference: form.ownerReference.trim(),
      }),
    onSuccess: async () => {
      setEditing(false)
      await refresh()
    },
  })
  const archive = useMutation({
    mutationFn: () =>
      a.archivedAt ? addressesApi.restore(a.id) : addressesApi.archive(a.id, null),
    onSuccess: refresh,
  })

  return (
    <>
      <h1 className="mt-2 break-all font-mono text-lg font-semibold">{a.address}</h1>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
        {a.network.displayName}
        {a.archivedAt && (
          <Badge tone="slate">
            Diarsipkan {new Date(a.archivedAt).toLocaleDateString('id-ID')}
          </Badge>
        )}
        {a.explorerUrl && (
          <a href={a.explorerUrl} target="_blank" rel="noreferrer noopener" className="underline">
            Lihat di explorer ↗
          </a>
        )}
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-4">
        <Item label="Aktivitas">
          <ActivityBadge status={a.activityStatus} />
        </Item>
        <Item label="Saldo">{a.balanceStatus}</Item>
        <Item label="Otorisasi">{a.authorizationStatus}</Item>
        <Item label="Recovery">{a.recoveryStatus}</Item>
        <Item label="Aktivitas terakhir">
          {a.lastActivityAt ? new Date(a.lastActivityAt).toLocaleDateString('id-ID') : '—'}
        </Item>
        <Item label="Hari tidak aktif">{a.inactiveDays ?? '—'}</Item>
        <Item label="Scan terakhir">
          {a.lastScannedAt ? new Date(a.lastScannedAt).toLocaleString('id-ID') : 'Belum pernah'}
        </Item>
        <Item label="Ditambahkan">{new Date(a.createdAt).toLocaleDateString('id-ID')}</Item>
        <Item label={`Estimasi nilai (${a.fiatCurrency})`}>
          {formatFiat(a.estimatedValue, a.fiatCurrency)}{' '}
          {a.estimatedValue !== null && a.valueSimulated && <Badge tone="amber">SIMULASI</Badge>}
        </Item>
      </dl>

      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">Kepemilikan</h2>
        {editing ? (
          <form
            aria-label="Ubah address"
            className="mt-3 grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate()
            }}
          >
            <Field
              label="Label"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
            <Field
              label="Owner reference"
              required
              value={form.ownerReference}
              onChange={(e) => setForm({ ...form, ownerReference: e.target.value })}
            />
            <div className="sm:col-span-2">
              <ErrorMessage error={save.error} />
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={save.isPending}>
                Simpan
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                Batal
              </Button>
            </div>
          </form>
        ) : (
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <Item label="Label">{a.label ?? '—'}</Item>
            <Item label="Owner reference">{a.ownerReference}</Item>
          </dl>
        )}
        {canManage && !editing && (
          <div className="mt-4 flex gap-2">
            {!a.archivedAt && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Ubah
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={archive.isPending}
              onClick={() => archive.mutate()}
            >
              {a.archivedAt ? 'Pulihkan dari arsip' : 'Arsipkan'}
            </Button>
          </div>
        )}
        <ErrorMessage error={archive.error} />
      </section>

      <OwnershipSection addressId={a.id} archived={a.archivedAt !== null} />
      <BalancesSection addressId={a.id} />
      <HistorySection addressId={a.id} />
    </>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase text-slate-500">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

function BalancesSection({ addressId }: { addressId: string }) {
  const balances = useQuery({
    queryKey: [...ADDRESSES_KEY, 'balances', addressId],
    queryFn: () => scansApi.addressBalances(addressId),
  })
  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-semibold">Saldo</h2>
      <ErrorMessage error={balances.error} />
      {balances.data?.length === 0 && (
        <p className="mt-2 text-sm text-slate-500">
          Belum ada data saldo. Jalankan scan untuk network ini.
        </p>
      )}
      {balances.data && balances.data.length > 0 && (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Aset</th>
              <th className="py-1 text-right">Jumlah</th>
              <th className="py-1 text-right">Estimasi nilai</th>
              <th className="py-1 text-right">Diperbarui</th>
            </tr>
          </thead>
          <tbody>
            {balances.data.map((b) => (
              <tr key={b.assetId} className="border-t border-slate-100">
                <td className="py-1.5">
                  <span className="font-medium">{b.symbol}</span>{' '}
                  <span className="text-slate-500">{b.name}</span>
                </td>
                {/* Exact decimal string from the server — never parsed into a float. */}
                <td className="py-1.5 text-right font-mono" title={`${b.quantity} base units`}>
                  {b.formatted}
                </td>
                <td
                  className="py-1.5 text-right font-mono"
                  title={
                    b.pricedAt
                      ? `Harga ${b.price} ${b.fiatCurrency} (${b.priceSource}, ${new Date(b.pricedAt).toLocaleString('id-ID')})`
                      : 'Belum ada harga'
                  }
                >
                  {formatFiat(b.fiatValue, b.fiatCurrency)}
                  {b.fiatValue !== null && b.simulated && (
                    <span className="ml-1">
                      <Badge tone="amber">SIMULASI</Badge>
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-right text-xs text-slate-500">
                  {new Date(b.updatedAt).toLocaleString('id-ID')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function HistorySection({ addressId }: { addressId: string }) {
  const history = useQuery({
    queryKey: [...ADDRESSES_KEY, 'activity', addressId],
    queryFn: () => scansApi.addressActivity(addressId),
  })
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('id-ID') : '—')
  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-semibold">Riwayat scan</h2>
      <ErrorMessage error={history.error} />
      {history.data?.length === 0 && (
        <p className="mt-2 text-sm text-slate-500">Belum pernah di-scan.</p>
      )}
      {history.data && history.data.length > 0 && (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Waktu scan</th>
              <th className="py-1">Status</th>
              <th className="py-1">Hari tidak aktif</th>
              <th className="py-1">Masuk / keluar terakhir</th>
              <th className="py-1">Tx masuk / keluar · nonce</th>
              <th className="py-1">Catatan</th>
            </tr>
          </thead>
          <tbody>
            {history.data.map((h) => (
              <tr key={h.scanId} className="border-t border-slate-100">
                <td className="py-1.5">
                  <Link to={`/scans/${h.scanId}`} className="underline-offset-2 hover:underline">
                    {new Date(h.scannedAt).toLocaleString('id-ID')}
                  </Link>
                </td>
                <td className="py-1.5">{h.activityStatus}</td>
                <td className="py-1.5">{h.inactiveDays ?? '—'}</td>
                <td className="py-1.5 text-xs">
                  {date(h.lastIncomingAt)} / {date(h.lastOutgoingAt)}
                </td>
                <td className="py-1.5 text-xs">
                  {h.incomingTxCount ?? '—'} / {h.outgoingTxCount ?? '—'} · {h.nonce ?? '—'}
                </td>
                <td className="space-x-1 py-1.5">
                  {h.errorCode && <Badge tone="red">{h.errorCode}</Badge>}
                  {h.reviewFlag && <Badge tone="amber">perlu review</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
