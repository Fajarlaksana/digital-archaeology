import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { useSensitive } from '../components/sensitive'
import { Badge, Button, ErrorMessage, Field } from '../components/ui'
import { formatFiat, transactionsApi, type PublicTransaction } from '../services/api'
import { ADDRESSES_KEY } from './AddressesPage'
import { STATUS_HINT, TRANSACTIONS_KEY, TxStatusBadge } from './TransactionsPage'

const EXPIRY_REASONS: Record<string, string> = {
  APPROVAL_TIMEOUT: 'Masa berlaku approval habis',
  NONCE_CHANGED: 'Nonce address berubah (ada transaksi lain dari address ini)',
  FEE_ABOVE_CAP: 'Fee jaringan naik di atas batas yang di-approve',
  BALANCE_INSUFFICIENT: 'Saldo tidak lagi cukup untuk jumlah + fee maksimum',
  DESTINATION_NOT_APPROVED: 'Destination tidak lagi berstatus APPROVED',
  AUTHORIZATION_INVALID: 'Otorisasi kepemilikan tidak lagi berlaku',
}

export function TransactionDetailPage() {
  const { id = '' } = useParams()
  const query = useQuery({
    queryKey: [...TRANSACTIONS_KEY, 'detail', id],
    queryFn: () => transactionsApi.get(id),
  })
  return (
    <section className="max-w-4xl">
      <Link to="/transactions" className="text-sm text-slate-500 hover:text-slate-900">
        ← Transactions
      </Link>
      <ErrorMessage error={query.error} />
      {query.data && <Detail tx={query.data} />}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-slate-100 py-2 sm:grid-cols-4">
      <dt className="text-xs uppercase text-slate-500">{label}</dt>
      <dd className="break-all sm:col-span-3">{children}</dd>
    </div>
  )
}

function Detail({ tx: t }: { tx: PublicTransaction }) {
  const { can, me } = useAuth()
  const queryClient = useQueryClient()
  const sensitive = useSensitive()
  const [action, setAction] = useState<'approve' | 'reject' | 'cancel' | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const isCreator = me?.user.id === t.createdBy?.id
  const approved = t.approvals.find((a) => a.decision === 'APPROVED')

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: TRANSACTIONS_KEY })
    await queryClient.invalidateQueries({ queryKey: ADDRESSES_KEY })
  }

  async function submit() {
    setError(null)
    const run = async () => {
      if (action === 'approve') await transactionsApi.approve(t.id, reason.trim())
      else if (action === 'reject') await transactionsApi.reject(t.id, reason.trim())
      else if (action === 'cancel') await transactionsApi.cancel(t.id, reason.trim())
      setAction(null)
      setReason('')
      await refresh()
    }
    if (action === 'cancel') {
      try {
        await run()
      } catch (err) {
        setError(err)
      }
    } else {
      // Decisions need a recent re-authentication. An expired preview also lands here.
      await sensitive.run(async () => {
        try {
          await run()
        } finally {
          await refresh()
        }
      })
    }
  }

  return (
    <>
      <h1 className="mt-2 flex flex-wrap items-center gap-2 text-lg font-semibold">
        Transaksi recovery <TxStatusBadge status={t.status} />
        {t.network.isTestnet && <Badge tone="blue">TESTNET</Badge>}
      </h1>
      {STATUS_HINT[t.status] && <p className="text-sm text-slate-600">{STATUS_HINT[t.status]}</p>}
      {t.statusReason && (
        <p className="mt-1 text-sm text-slate-700">
          Alasan: {EXPIRY_REASONS[t.statusReason] ?? t.statusReason}
        </p>
      )}

      {/* SA 4.8: everything that will be signed is shown again for review. */}
      <section
        aria-label="Ringkasan transaksi"
        className="mt-4 rounded-lg border-2 border-slate-300 bg-white p-4 text-sm"
      >
        <h2 className="font-semibold">Periksa sebelum approve</h2>
        <dl className="mt-2">
          <Row label="Source">
            <Link to={`/addresses/${t.source.addressId}`} className="font-mono underline">
              {t.source.address}
            </Link>
            {t.source.label && <span className="ml-2 text-slate-500">({t.source.label})</span>}
          </Row>
          <Row label="Destination">
            <span className="font-mono">{t.destination.address}</span>
            <span className="ml-2 text-slate-500">({t.destination.label}, APPROVED)</span>
          </Row>
          <Row label="Asset">
            {t.asset.symbol}
            {t.asset.contractAddress && (
              <span className="ml-2 font-mono text-xs text-slate-500">
                {t.asset.contractAddress}
              </span>
            )}
          </Row>
          <Row label="Amount">
            <span className="font-mono">
              {t.amountFormatted} {t.asset.symbol}
            </span>{' '}
            {t.sweep ? (
              <Badge tone="slate">SWEEP</Badge>
            ) : (
              <Badge tone="amber">TEST TRANSFER</Badge>
            )}
            <span className="ml-2 text-slate-500">
              ≈ {formatFiat(t.estimatedValue, t.fiatCurrency)}
              {t.valueSimulated && t.estimatedValue !== null && ' (SIMULASI)'}
            </span>
          </Row>
          <Row label="Fee maksimum">
            <span className="font-mono">
              {t.networkFeeFormatted} {t.nativeSymbol}
            </span>
            <span className="ml-2 text-xs text-slate-500">
              gas {t.gasLimit} × maxFee {t.maxFeePerGas} wei (tip {t.maxPriorityFeePerGas})
            </span>
          </Row>
          <Row label="Network">
            {t.network.displayName} (chainId {t.network.chainId ?? 'n/a'}) · nonce {t.nonce}
          </Row>
          <Row label="Hash unsigned">
            <span className="font-mono text-xs">{t.unsignedHash}</span>
          </Row>
        </dl>
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-slate-500">Payload unsigned (JSON)</summary>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2">
            {JSON.stringify(t.unsignedPayload, null, 2)}
          </pre>
        </details>
      </section>

      {approved?.expiresAt && t.status === 'APPROVED' && (
        <p className="mt-3 text-sm">
          Approval berlaku sampai {new Date(approved.expiresAt).toLocaleString('id-ID')}. Setelah
          itu, atau bila nonce/fee/saldo berubah di luar batas, transaksi kedaluwarsa.
        </p>
      )}

      <ul aria-label="Riwayat approval" className="mt-3 space-y-1 text-xs text-slate-600">
        <li>
          Preview dibuat oleh {t.createdBy?.name ?? '—'} (
          {new Date(t.createdAt).toLocaleString('id-ID')})
        </li>
        {t.approvals
          .filter((a) => a.decision)
          .map((a) => (
            <li key={a.id}>
              {a.decision === 'APPROVED' ? 'Approved' : 'Ditolak'} oleh {a.decidedBy?.name ?? '—'}
              {a.decidedAt && ` (${new Date(a.decidedAt).toLocaleString('id-ID')})`}
              {a.reason && ` — ${a.reason}`}
            </li>
          ))}
      </ul>

      <div className="mt-4 flex flex-wrap gap-2">
        {t.status === 'CREATED' && can('transactions:approve') && !isCreator && (
          <>
            <Button onClick={() => setAction('approve')}>Approve</Button>
            <Button variant="secondary" onClick={() => setAction('reject')}>
              Tolak
            </Button>
          </>
        )}
        {(t.status === 'CREATED' || t.status === 'APPROVED') && can('transactions:create') && (
          <Button variant="secondary" onClick={() => setAction('cancel')}>
            Batalkan
          </Button>
        )}
      </div>
      {t.status === 'CREATED' && can('transactions:approve') && isCreator && (
        <p className="mt-2 text-xs text-slate-500">
          Anda membuat preview ini, jadi approval harus dari REVIEWER lain.
        </p>
      )}

      {action && (
        <form
          aria-label={
            action === 'approve'
              ? 'Approve transaksi'
              : action === 'reject'
                ? 'Tolak transaksi'
                : 'Batalkan transaksi'
          }
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="min-w-0 flex-1">
            <Field
              label="Alasan"
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={reason.trim().length < 3}>
            {action === 'approve'
              ? 'Approve'
              : action === 'reject'
                ? 'Tolak'
                : 'Batalkan transaksi'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setAction(null)}>
            Kembali
          </Button>
        </form>
      )}
      {sensitive.panel}
      <ErrorMessage error={sensitive.error} />
      <ErrorMessage error={error} />
    </>
  )
}
