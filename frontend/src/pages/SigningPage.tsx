import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Badge, ErrorMessage } from '../components/ui'
import { transactionsApi, vaultApi } from '../services/api'
import { TRANSACTIONS_KEY } from './TransactionsPage'

/**
 * SUPER_ADMIN signing queue (Phase 10, ADR-023): APPROVED transactions waiting for a signature.
 * Signing itself happens on the transaction page after the full review (SA 4.8).
 */
export function SigningPage() {
  const queue = useQuery({
    queryKey: [...TRANSACTIONS_KEY, 'list', 'APPROVED'],
    queryFn: () => transactionsApi.list({ status: 'APPROVED' }),
  })
  const vault = useQuery({ queryKey: ['vault', 'status'], queryFn: vaultApi.status })
  const toBroadcast = useQuery({
    queryKey: [...TRANSACTIONS_KEY, 'list', 'SIGNED'],
    queryFn: () => transactionsApi.list({ status: 'SIGNED' }),
  })

  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">Signing</h1>
      <p className="mt-1 text-sm text-slate-600">
        Transaksi yang sudah di-approve REVIEWER dan menunggu tanda tangan. Signer hanya menerima ID
        transaksi dan memverifikasi sendiri data yang di-approve; key tidak pernah meninggalkan
        signer. Anda tidak bisa menandatangani transaksi yang Anda buat atau approve sendiri.
      </p>
      {vault.data && (
        <p
          role="status"
          className={`mt-3 rounded-md px-3 py-2 text-sm ${vault.data.unlocked ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}
        >
          {vault.data.unlocked ? (
            <>Vault terbuka sampai {new Date(vault.data.expiresAt!).toLocaleTimeString('id-ID')}.</>
          ) : (
            <>
              Vault terkunci. Buka dulu di{' '}
              <Link to="/key-vault" className="underline">
                Key Vault
              </Link>{' '}
              sebelum menandatangani.
            </>
          )}
        </p>
      )}
      <ErrorMessage error={queue.error ?? vault.error} />
      <ul className="mt-4 space-y-2">
        {queue.data?.map((t) => {
          const approval = t.approvals.find((a) => a.decision === 'APPROVED')
          return (
            <li key={t.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <Link
                to={`/transactions/${t.id}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {t.amountFormatted} {t.asset.symbol} → {t.destination.label}
              </Link>{' '}
              <Badge tone="blue">{t.network.displayName}</Badge>
              <p className="mt-1 text-xs text-slate-500">
                Dari {t.source.label ?? t.source.address} · dibuat {t.createdBy?.name ?? '—'} ·
                di-approve {approval?.decidedBy?.name ?? '—'}
                {approval?.expiresAt &&
                  ` · berlaku sampai ${new Date(approval.expiresAt).toLocaleTimeString('id-ID')}`}
              </p>
            </li>
          )
        })}
        {queue.data?.length === 0 && (
          <li className="text-sm text-slate-500">
            Tidak ada transaksi yang menunggu tanda tangan.
          </li>
        )}
      </ul>
      <h2 className="mt-6 font-semibold">Siap di-broadcast</h2>
      <ul className="mt-2 space-y-2">
        {toBroadcast.data?.map((t) => (
          <li key={t.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <Link
              to={`/transactions/${t.id}`}
              className="font-medium underline-offset-2 hover:underline"
            >
              {t.amountFormatted} {t.asset.symbol} → {t.destination.label}
            </Link>{' '}
            <Badge tone="blue">{t.network.displayName}</Badge>
          </li>
        ))}
        {toBroadcast.data?.length === 0 && (
          <li className="text-sm text-slate-500">Tidak ada transaksi yang menunggu broadcast.</li>
        )}
      </ul>
    </section>
  )
}
