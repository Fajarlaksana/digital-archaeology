import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { ErrorMessage } from '../components/ui'
import { ownershipApi, type AuthorizationStatus } from '../services/api'
import { AUTHORIZATIONS_KEY, AuthorizationStatusBadge } from './OwnershipSection'

const STATUSES: AuthorizationStatus[] = ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED']

/** Overview of all authorization records; verification itself happens on the address page. */
export function AuthorizationsPage() {
  const [status, setStatus] = useState<AuthorizationStatus | ''>('')
  const list = useQuery({
    queryKey: [...AUTHORIZATIONS_KEY, 'list', status],
    queryFn: () => ownershipApi.list(status || undefined),
  })

  return (
    <section>
      <h1 className="text-xl font-semibold">Authorizations</h1>
      <p className="mt-1 text-sm text-slate-600">
        Dasar otorisasi tiap address dan hasil verifikasi kepemilikan. Untuk menambah otorisasi atau
        memverifikasi, buka detail address.
      </p>
      <label className="mt-4 block text-sm">
        <span className="font-medium text-slate-700">Status</span>
        <select
          className="mt-1 block rounded-md border border-slate-300 px-2 py-2 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value as AuthorizationStatus | '')}
        >
          <option value="">Semua</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <ErrorMessage error={list.error} />
      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Address</th>
              <th className="px-4 py-2">Network</th>
              <th className="px-4 py-2">Jenis</th>
              <th className="px-4 py-2">Referensi</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Terverifikasi</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((a) => (
              <tr key={a.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-mono text-xs">
                  <Link
                    to={`/addresses/${a.address.id}`}
                    className="underline-offset-2 hover:underline"
                    title={a.address.address}
                  >
                    {a.address.label ?? `${a.address.address.slice(0, 10)}…`}
                  </Link>
                </td>
                <td className="px-4 py-2">{a.address.network}</td>
                <td className="px-4 py-2">{a.type}</td>
                <td className="px-4 py-2">{a.reference}</td>
                <td className="px-4 py-2">
                  <AuthorizationStatusBadge status={a.status} />
                </td>
                <td className="px-4 py-2 text-xs">
                  {a.verifiedAt ? new Date(a.verifiedAt).toLocaleString('id-ID') : '—'}
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  Belum ada data otorisasi.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
