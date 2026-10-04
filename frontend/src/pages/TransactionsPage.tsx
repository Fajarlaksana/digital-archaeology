import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { Badge, ErrorMessage } from '../components/ui'
import { transactionsApi, type TransactionStatus } from '../services/api'

export const TRANSACTIONS_KEY = ['transactions'] as const

const TONE: Record<TransactionStatus, 'green' | 'amber' | 'red' | 'slate' | 'blue'> = {
  CREATED: 'amber',
  APPROVED: 'green',
  REJECTED: 'red',
  EXPIRED: 'slate',
  CANCELLED: 'slate',
  SIGNED: 'blue',
  BROADCASTED: 'blue',
  PENDING: 'blue',
  CONFIRMED: 'green',
  FAILED: 'red',
}

export const STATUS_HINT: Partial<Record<TransactionStatus, string>> = {
  CREATED: 'Menunggu approval REVIEWER',
  APPROVED: 'Disetujui, menunggu tanda tangan SUPER_ADMIN',
  SIGNED: 'Ditandatangani, menunggu broadcast oleh SUPER_ADMIN',
  BROADCASTED: 'Terkirim ke jaringan, menunggu masuk blok',
  PENDING: 'Sudah masuk blok, menunggu konfirmasi',
  CONFIRMED: 'Selesai: aset sudah dipindahkan',
  FAILED: 'Gagal di jaringan',
  EXPIRED: 'Kedaluwarsa, buat preview baru',
}

export function TxStatusBadge({ status }: { status: TransactionStatus }) {
  return <Badge tone={TONE[status]}>{status}</Badge>
}

const FILTERS: TransactionStatus[] = [
  'CREATED',
  'APPROVED',
  'SIGNED',
  'BROADCASTED',
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
]

/** Recovery transactions (Phase 9): previews, approvals and — later — signing & broadcast. */
export function TransactionsPage() {
  const [status, setStatus] = useState<TransactionStatus | ''>('')
  const list = useQuery({
    queryKey: [...TRANSACTIONS_KEY, 'list', status],
    queryFn: () => transactionsApi.list({ status: status || undefined }),
  })

  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">Transactions</h1>
      <p className="mt-1 text-sm text-slate-600">
        Transaksi recovery. ANALYST membuat preview dari detail address; REVIEWER lain memeriksa
        ulang lalu meng-approve. Signing dan broadcast tersedia di Fase 10–11.
      </p>
      <label className="mt-4 block text-sm">
        <span className="font-medium text-slate-700">Status</span>
        <select
          className="mt-1 block rounded-md border border-slate-300 px-2 py-2 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value as TransactionStatus | '')}
        >
          <option value="">Semua</option>
          {FILTERS.map((s) => (
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
              <th className="px-4 py-2">Dibuat</th>
              <th className="px-4 py-2">Source → Destination</th>
              <th className="px-4 py-2 text-right">Jumlah</th>
              <th className="px-4 py-2">Network</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((t) => (
              <tr key={t.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 text-xs">
                  <Link to={`/transactions/${t.id}`} className="underline-offset-2 hover:underline">
                    {new Date(t.createdAt).toLocaleString('id-ID')}
                  </Link>
                </td>
                <td className="px-4 py-2 text-xs">
                  {t.source.label ?? t.source.address.slice(0, 10)} → {t.destination.label}
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  {t.amountFormatted} {t.asset.symbol}
                </td>
                <td className="px-4 py-2">{t.network.displayName}</td>
                <td className="px-4 py-2">
                  <TxStatusBadge status={t.status} />
                  {t.stuck && (
                    <span className="ml-1">
                      <Badge tone="red">STUCK</Badge>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  Belum ada transaksi.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
