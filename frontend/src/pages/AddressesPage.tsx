import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { Badge, Button, ErrorMessage, Field } from '../components/ui'
import {
  addressesApi,
  networksApi,
  type AddressQuery,
  type ImportRowResult,
  type ImportSummary,
  type PublicAddress,
  formatFiat,
  reportUrls,
} from '../services/api'
import { NETWORKS_KEY } from './NetworksPage'

export const ADDRESSES_KEY = ['addresses'] as const
const PAGE_SIZE = 50

export const IMPORT_TEMPLATE =
  'address,network,label,owner_reference\n0x0000000000000000000000000000000000000001,sepolia,Contoh wallet,SELF\n'

export function AddressesPage() {
  const { can } = useAuth()
  const canManage = can('addresses:manage')
  const [query, setQuery] = useState<AddressQuery>({
    archived: 'exclude',
    page: 1,
    pageSize: PAGE_SIZE,
  })
  const [searchDraft, setSearchDraft] = useState('')
  const [panel, setPanel] = useState<'none' | 'create' | 'import'>('none')

  const networks = useQuery({ queryKey: NETWORKS_KEY, queryFn: networksApi.list })
  const addresses = useQuery({
    queryKey: [...ADDRESSES_KEY, query],
    queryFn: () => addressesApi.list(query),
    placeholderData: keepPreviousData,
  })
  const page = query.page ?? 1
  const totalPages = Math.max(1, Math.ceil((addresses.data?.total ?? 0) / PAGE_SIZE))

  return (
    <section className="max-w-6xl">
      <h1 className="text-2xl font-semibold">Addresses</h1>
      <p className="mt-1 text-slate-600">
        Inventaris address milik sendiri atau yang punya mandat. Setiap address wajib punya owner
        reference.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {canManage && (
          <>
            <Button onClick={() => setPanel(panel === 'create' ? 'none' : 'create')}>
              Tambah address
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPanel(panel === 'import' ? 'none' : 'import')}
            >
              Import CSV
            </Button>
          </>
        )}
        {can('reports:read') && (
          <>
            <a
              href={reportUrls.inventory}
              download
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Export inventaris (CSV)
            </a>
            <a
              href={reportUrls.inactivity}
              download
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Export tidak aktif (CSV)
            </a>
          </>
        )}
      </div>
      {panel === 'create' && <CreateAddressForm onDone={() => setPanel('none')} />}
      {panel === 'import' && <ImportPanel />}

      <form
        role="search"
        className="mt-6 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          setQuery({ ...query, search: searchDraft.trim() || undefined, page: 1 })
        }}
      >
        <label className="text-sm">
          <span className="block font-medium text-slate-700">Network</span>
          <select
            className="mt-1 rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={query.networkId ?? ''}
            onChange={(e) =>
              setQuery({ ...query, networkId: e.target.value || undefined, page: 1 })
            }
          >
            <option value="">Semua</option>
            {networks.data?.map((n) => (
              <option key={n.id} value={n.id}>
                {n.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block font-medium text-slate-700">Tampilkan</span>
          <select
            className="mt-1 rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={query.archived}
            onChange={(e) =>
              setQuery({ ...query, archived: e.target.value as AddressQuery['archived'], page: 1 })
            }
          >
            <option value="exclude">Aktif</option>
            <option value="only">Diarsipkan</option>
            <option value="include">Semua</option>
          </select>
        </label>
        <div className="w-64">
          <Field
            label="Cari"
            placeholder="address, label, owner ref"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary">
          Cari
        </Button>
      </form>

      <ErrorMessage error={addresses.error} />
      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Address</th>
              <th className="px-4 py-2">Network</th>
              <th className="px-4 py-2">Label</th>
              <th className="px-4 py-2">Owner ref</th>
              <th className="px-4 py-2">Aktivitas</th>
              <th className="px-4 py-2 text-right">Estimasi nilai</th>
            </tr>
          </thead>
          <tbody>
            {addresses.data?.items.map((a) => (
              <AddressRow key={a.id} address={a} />
            ))}
          </tbody>
        </table>
        {addresses.data?.items.length === 0 && (
          <p className="p-4 text-sm text-slate-500">Tidak ada address.</p>
        )}
      </div>

      <nav aria-label="Halaman" className="mt-3 flex items-center gap-3 text-sm text-slate-600">
        <Button
          variant="secondary"
          disabled={page <= 1}
          onClick={() => setQuery({ ...query, page: page - 1 })}
        >
          Sebelumnya
        </Button>
        <span>
          Halaman {page} / {totalPages} · {addresses.data?.total ?? 0} address
        </span>
        <Button
          variant="secondary"
          disabled={page >= totalPages}
          onClick={() => setQuery({ ...query, page: page + 1 })}
        >
          Berikutnya
        </Button>
      </nav>
    </section>
  )
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`
}

export function ActivityBadge({ status }: { status: PublicAddress['activityStatus'] }) {
  const tone = status === 'ACTIVE' ? 'green' : status === 'INACTIVE' ? 'amber' : 'slate'
  return <Badge tone={tone}>{status}</Badge>
}

function AddressRow({ address: a }: { address: PublicAddress }) {
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="px-4 py-2 font-mono text-xs">
        <Link
          to={`/addresses/${a.id}`}
          className="text-slate-900 underline-offset-2 hover:underline"
          title={a.address}
        >
          {shortAddress(a.address)}
        </Link>
        {a.archivedAt && (
          <span className="ml-2">
            <Badge tone="slate">arsip</Badge>
          </span>
        )}
      </td>
      <td className="px-4 py-2">{a.network.displayName}</td>
      <td className="px-4 py-2">{a.label ?? '—'}</td>
      <td className="px-4 py-2">{a.ownerReference}</td>
      <td className="px-4 py-2">
        <ActivityBadge status={a.activityStatus} />
      </td>
      <td className="px-4 py-2 text-right font-mono text-xs">
        {formatFiat(a.estimatedValue, a.fiatCurrency)}
        {a.estimatedValue !== null && a.valueSimulated && (
          <span className="ml-1" title="Testnet: dihargai seperti mainnet, tidak bernilai nyata">
            <Badge tone="amber">sim</Badge>
          </span>
        )}
      </td>
    </tr>
  )
}

function CreateAddressForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const networks = useQuery({ queryKey: NETWORKS_KEY, queryFn: networksApi.list })
  const active = networks.data?.filter((n) => n.status === 'ACTIVE') ?? []
  const [form, setForm] = useState({ networkId: '', address: '', label: '', ownerReference: '' })
  const create = useMutation({
    mutationFn: () =>
      addressesApi.create({
        networkId: form.networkId || active[0]?.id || '',
        address: form.address.trim(),
        label: form.label.trim() || null,
        ownerReference: form.ownerReference.trim(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ADDRESSES_KEY })
      onDone()
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    create.mutate()
  }

  return (
    <form
      aria-label="Tambah address"
      onSubmit={onSubmit}
      className="mt-4 grid max-w-2xl gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2"
    >
      <label className="text-sm">
        <span className="block font-medium text-slate-700">Network</span>
        <select
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
          value={form.networkId || active[0]?.id || ''}
          onChange={(e) => setForm({ ...form, networkId: e.target.value })}
        >
          {active.map((n) => (
            <option key={n.id} value={n.id}>
              {n.displayName}
            </option>
          ))}
        </select>
      </label>
      <Field
        label="Address"
        required
        placeholder="0x…"
        value={form.address}
        onChange={(e) => setForm({ ...form, address: e.target.value })}
      />
      <Field
        label="Label"
        value={form.label}
        onChange={(e) => setForm({ ...form, label: e.target.value })}
      />
      <Field
        label="Owner reference"
        required
        placeholder="SELF / nomor kontrak / ID kasus"
        hint="Siapa pemiliknya atau dasar mandatnya. Wajib."
        value={form.ownerReference}
        onChange={(e) => setForm({ ...form, ownerReference: e.target.value })}
      />
      <div className="sm:col-span-2">
        <ErrorMessage error={create.error} />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={create.isPending}>
          Simpan
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Batal
        </Button>
      </div>
    </form>
  )
}

const REASON_LABELS: Record<string, string> = {
  INVALID_FORMAT: 'Format address salah',
  BAD_CHECKSUM: 'Checksum salah (kemungkinan salah ketik)',
  ZERO_ADDRESS: 'Zero address',
  UNKNOWN_NETWORK: 'Network tidak dikenal',
  NETWORK_DISABLED: 'Network nonaktif',
  MISSING_OWNER_REFERENCE: 'owner_reference kosong',
  FIELD_TOO_LONG: 'Isian terlalu panjang',
  DUPLICATE_IN_FILE: 'Duplikat di file',
  ALREADY_EXISTS: 'Sudah terdaftar',
}

export function ImportPanel() {
  const queryClient = useQueryClient()
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const preview = useMutation({ mutationFn: addressesApi.previewImport })
  const commit = useMutation({
    mutationFn: addressesApi.commitImport,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADDRESSES_KEY }),
  })

  async function onFile(file: File | undefined) {
    if (!file) return
    setFileName(file.name)
    setCsv(await file.text())
    preview.reset()
    commit.reset()
  }

  return (
    <section
      aria-label="Import CSV"
      className="mt-4 max-w-4xl space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="text-sm text-slate-600">
        <p>
          Kolom: <code className="font-mono">address,network,label,owner_reference</code> (label
          opsional). Maksimal 5.000 baris per file. Sistem memeriksa dulu; tidak ada yang disimpan
          sebelum Anda menekan <strong>Simpan</strong>.
        </p>
        <a
          className="text-slate-900 underline"
          download="template-address.csv"
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_TEMPLATE)}`}
        >
          Unduh template CSV
        </a>
      </div>

      <input
        type="file"
        accept=".csv,text/csv"
        aria-label="File CSV"
        onChange={(e) => void onFile(e.target.files?.[0])}
        className="block text-sm"
      />

      <div className="flex gap-2">
        <Button disabled={!csv || preview.isPending} onClick={() => preview.mutate(csv)}>
          {preview.isPending ? 'Memeriksa…' : `Periksa ${fileName ?? ''}`}
        </Button>
        {preview.data && preview.data.summary.valid > 0 && !commit.data && (
          <Button disabled={commit.isPending} onClick={() => commit.mutate(csv)}>
            Simpan {preview.data.summary.valid} baris valid
          </Button>
        )}
      </div>

      <ErrorMessage error={preview.error ?? commit.error} />

      {commit.data && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {commit.data.created} address tersimpan. {commit.data.summary.rejected} baris ditolak.
        </p>
      )}

      {preview.data && !commit.data && (
        <ImportReport summary={preview.data.summary} results={preview.data.results} />
      )}
    </section>
  )
}

function ImportReport({
  summary,
  results,
}: {
  summary: ImportSummary
  results: ImportRowResult[]
}) {
  const rejected = results.filter((r) => r.status === 'REJECTED')
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm">
        <strong>{summary.total}</strong> baris ·{' '}
        <span className="text-emerald-700">{summary.valid} valid</span> ·{' '}
        <span className="text-red-700">{summary.rejected} ditolak</span>
      </p>
      {Object.keys(summary.byReason).length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs">
          {Object.entries(summary.byReason).map(([reason, count]) => (
            <li key={reason}>
              <Badge tone="red">
                {REASON_LABELS[reason] ?? reason}: {count}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {rejected.length > 0 && (
        <div className="max-h-80 overflow-auto rounded border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-50 uppercase text-slate-500">
              <tr>
                <th className="px-3 py-1.5">Baris</th>
                <th className="px-3 py-1.5">Address</th>
                <th className="px-3 py-1.5">Network</th>
                <th className="px-3 py-1.5">Alasan</th>
              </tr>
            </thead>
            <tbody>
              {rejected.map((r) => (
                <tr key={r.line} className="border-t border-slate-100">
                  <td className="px-3 py-1.5">{r.line}</td>
                  <td className="px-3 py-1.5 font-mono">{r.input.address || '—'}</td>
                  <td className="px-3 py-1.5">{r.input.network || '—'}</td>
                  <td className="px-3 py-1.5">{r.status === 'REJECTED' ? r.message : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
