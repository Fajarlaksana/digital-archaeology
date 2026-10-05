import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { Badge, Button, ErrorMessage, Field } from '../components/ui'
import { dayBound } from '../lib/dates'
import { auditApi, type AuditFilter, type AuditResult } from '../services/api'

const RESULT_TONE: Record<AuditResult, 'green' | 'amber' | 'red'> = {
  SUCCESS: 'green',
  DENIED: 'amber',
  FAILURE: 'red',
}

/**
 * Audit trail for AUDITOR (Phase 12, ADR-025): read-only, filterable, exportable, with a
 * hash-chain integrity check. Metadata was redacted when it was written.
 */
export function AuditLogsPage() {
  const [form, setForm] = useState({ action: '', result: '', resourceId: '', from: '', to: '' })
  const [applied, setApplied] = useState<AuditFilter>({})
  const [open, setOpen] = useState<string | null>(null)
  const actions = useQuery({ queryKey: ['audit', 'actions'], queryFn: auditApi.actions })
  const list = useInfiniteQuery({
    queryKey: ['audit', 'list', applied],
    queryFn: ({ pageParam }) => auditApi.list({ ...applied, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  })
  const verify = useMutation({ mutationFn: auditApi.verify })

  function apply(event: React.FormEvent) {
    event.preventDefault()
    setApplied({
      action: form.action || undefined,
      result: (form.result || undefined) as AuditResult | undefined,
      resourceId: form.resourceId.trim() || undefined,
      from: dayBound(form.from),
      to: dayBound(form.to, true),
    })
  }

  const entries = list.data?.pages.flatMap((p) => p.items) ?? []
  const check = verify.data

  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">Audit Logs</h1>
      <p className="mt-1 text-sm text-slate-600">
        Jejak seluruh aktivitas, hanya-baca. Setiap baris terhubung ke baris sebelumnya dengan hash
        (SHA-256), sehingga perubahan atau penghapusan bisa dideteksi.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" disabled={verify.isPending} onClick={() => verify.mutate()}>
          {verify.isPending ? 'Memeriksa…' : 'Verifikasi integritas'}
        </Button>
        <a href={auditApi.csvUrl(applied)} className="text-sm underline" download>
          Unduh CSV (filter saat ini)
        </a>
      </div>
      <ErrorMessage error={verify.error} />
      {check && (
        <div
          role="status"
          className={`mt-3 rounded-md px-3 py-2 text-sm ${check.ok ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-800'}`}
        >
          {check.ok ? (
            <>
              Rantai utuh: {check.checked} baris diperiksa. Catat <strong>head</strong> ini di luar
              sistem untuk mendeteksi penghapusan baris terbaru kelak: #{check.headSequence}{' '}
              <span className="break-all font-mono text-xs">{check.headHash}</span>
            </>
          ) : (
            <>
              Rantai RUSAK mulai baris #{check.firstBrokenSequence} (
              {check.reason === 'ROW_MODIFIED' ? 'isi baris diubah' : 'baris dihapus/disisipkan'}).
              Segera laporkan dan amankan database.
            </>
          )}
        </div>
      )}

      <form
        aria-label="Filter audit"
        onSubmit={apply}
        className="mt-4 grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-6"
      >
        <label className="block text-sm sm:col-span-2">
          <span className="font-medium text-slate-700">Aksi</span>
          <select
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={form.action}
            onChange={(e) => setForm({ ...form, action: e.target.value })}
          >
            <option value="">Semua</option>
            {actions.data?.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Hasil</span>
          <select
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={form.result}
            onChange={(e) => setForm({ ...form, result: e.target.value })}
          >
            <option value="">Semua</option>
            <option value="SUCCESS">SUCCESS</option>
            <option value="DENIED">DENIED</option>
            <option value="FAILURE">FAILURE</option>
          </select>
        </label>
        <Field
          label="Resource ID"
          value={form.resourceId}
          onChange={(e) => setForm({ ...form, resourceId: e.target.value })}
        />
        <Field
          label="Dari tanggal"
          type="date"
          value={form.from}
          onChange={(e) => setForm({ ...form, from: e.target.value })}
        />
        <Field
          label="Sampai tanggal"
          type="date"
          value={form.to}
          onChange={(e) => setForm({ ...form, to: e.target.value })}
        />
        <div className="sm:col-span-6">
          <Button type="submit">Terapkan filter</Button>
        </div>
      </form>

      <ErrorMessage error={list.error} />
      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Waktu</th>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Aksi</th>
              <th className="px-3 py-2">Hasil</th>
              <th className="px-3 py-2">Resource</th>
              <th className="px-3 py-2">IP</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <Fragment key={e.sequence}>
                <tr
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => setOpen(open === e.sequence ? null : e.sequence)}
                >
                  <td className="px-3 py-1.5 font-mono text-xs">{e.sequence}</td>
                  <td className="px-3 py-1.5 text-xs">
                    {new Date(e.createdAt).toLocaleString('id-ID')}
                  </td>
                  <td className="px-3 py-1.5 text-xs">{e.user?.email ?? 'sistem'}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{e.action}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone={RESULT_TONE[e.result]}>{e.result}</Badge>
                  </td>
                  <td className="px-3 py-1.5 text-xs">
                    {e.resourceType ?? '—'}
                    {e.resourceId && (
                      <span className="ml-1 font-mono text-slate-500">{e.resourceId}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-xs">{e.ipAddress ?? '—'}</td>
                </tr>
                {open === e.sequence && (
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <td colSpan={7} className="px-3 py-2">
                      <pre
                        aria-label={`Metadata #${e.sequence}`}
                        className="overflow-x-auto text-xs"
                      >
                        {JSON.stringify(e.metadata, null, 2)}
                      </pre>
                      <p className="mt-1 break-all font-mono text-[11px] text-slate-500">
                        request {e.requestId ?? '—'} · hash {e.hash} · prev {e.prevHash}
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {list.isSuccess && entries.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  Tidak ada entri untuk filter ini.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {list.hasNextPage && (
        <div className="mt-3">
          <Button
            variant="secondary"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Muat lebih banyak
          </Button>
        </div>
      )}
    </section>
  )
}
