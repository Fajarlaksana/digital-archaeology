import { useMutation, useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { Badge, Button, ErrorMessage, Field } from '../components/ui'
import { RecoveryBadge, REASONS, reasonLabel } from '../eligibility'
import {
  destinationsApi,
  eligibilityApi,
  formatFiat,
  transactionsApi,
  type AssetEligibility,
  type PublicAddress,
} from '../services/api'
import { ADDRESSES_KEY } from './AddressesPage'
import { TRANSACTIONS_KEY, TxStatusBadge } from './TransactionsPage'

/** Per-asset eligibility of one address (Phase 8b). Information only — nothing is moved. */
export function EligibilitySection({ address: a }: { address: PublicAddress }) {
  const { can } = useAuth()
  const [previewFor, setPreviewFor] = useState<AssetEligibility | null>(null)
  const assets = useQuery({
    queryKey: [...ADDRESSES_KEY, 'eligibility', a.id],
    queryFn: () => eligibilityApi.forAddress(a.id),
  })
  const active = useQuery({
    queryKey: [...TRANSACTIONS_KEY, 'address', a.id],
    queryFn: () => transactionsApi.list({ addressId: a.id }),
    enabled: can('transactions:read'),
  })
  const inFlight = active.data?.find((t) =>
    ['CREATED', 'APPROVED', 'SIGNED', 'BROADCASTED', 'PENDING'].includes(t.status),
  )
  const canPreview = can('transactions:create') && active.isSuccess && !inFlight

  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="flex flex-wrap items-center gap-2 font-semibold">
        Kelayakan recovery <RecoveryBadge status={a.recoveryStatus} />
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        {a.eligibilityCheckedAt
          ? `Dinilai ${new Date(a.eligibilityCheckedAt).toLocaleString('id-ID')} (otomatis setelah scan, atau Hitung ulang di menu Recovery).`
          : 'Belum pernah dinilai. Jalankan scan atau Hitung ulang di menu Recovery.'}
      </p>
      {a.recoveryReasons.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm">
          {a.recoveryReasons.map((code) => (
            <li key={code}>
              <span className="font-medium">{reasonLabel(code)}</span>
              {REASONS[code] && <span className="text-slate-500"> — {REASONS[code].action}</span>}
            </li>
          ))}
        </ul>
      )}
      <ErrorMessage error={assets.error} />
      {assets.data && assets.data.length > 0 && (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Aset</th>
              <th className="py-1">Status</th>
              <th className="py-1 text-right">Jumlah</th>
              <th className="py-1 text-right">Nilai</th>
              <th className="py-1 text-right">Estimasi fee</th>
              <th className="py-1 text-right">Bersih</th>
              {canPreview && <th className="py-1" />}
            </tr>
          </thead>
          <tbody>
            {assets.data.map((e) => (
              <tr key={e.assetId} className="border-t border-slate-100">
                <td className="py-1.5 font-medium">{e.symbol}</td>
                <td className="py-1.5">
                  <RecoveryBadge status={e.status} />
                  {e.reason && (
                    <span className="ml-1 text-xs text-slate-500">{reasonLabel(e.reason)}</span>
                  )}
                </td>
                <td className="py-1.5 text-right font-mono" title={`${e.quantity} base units`}>
                  {e.formatted}
                </td>
                <td className="py-1.5 text-right font-mono">
                  {formatFiat(e.valueFiat, e.fiatCurrency)}
                </td>
                <td
                  className="py-1.5 text-right font-mono"
                  title={e.feeEstimate ? `${e.feeEstimate} base units native` : undefined}
                >
                  {formatFiat(e.feeFiat, e.fiatCurrency)}
                </td>
                <td className="py-1.5 text-right font-mono">
                  {formatFiat(e.netFiat, e.fiatCurrency)}
                  {e.simulated && e.netFiat !== null && (
                    <span className="ml-1">
                      <Badge tone="amber">SIMULASI</Badge>
                    </span>
                  )}
                </td>
                {canPreview && (
                  <td className="py-1.5 text-right">
                    {e.quantity !== '0' && (
                      <Button variant="secondary" onClick={() => setPreviewFor(e)}>
                        Buat preview
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {inFlight && (
        <p className="mt-3 text-sm">
          Transaksi aktif: <TxStatusBadge status={inFlight.status} />{' '}
          <Link to={`/transactions/${inFlight.id}`} className="underline">
            {inFlight.amountFormatted} {inFlight.asset.symbol} → {inFlight.destination.label}
          </Link>
        </p>
      )}
      {previewFor && canPreview && (
        <PreviewForm address={a} asset={previewFor} onClose={() => setPreviewFor(null)} />
      )}
    </section>
  )
}

/** Builds an unsigned transaction from live chain data (Phase 9). Nothing is signed here. */
function PreviewForm({
  address,
  asset,
  onClose,
}: {
  address: PublicAddress
  asset: AssetEligibility
  onClose: () => void
}) {
  const navigate = useNavigate()
  const destinations = useQuery({
    queryKey: ['destinations', 'APPROVED'],
    queryFn: () => destinationsApi.list('APPROVED'),
  })
  const options = destinations.data?.filter((d) => d.network.id === address.network.id) ?? []
  const [destinationId, setDestinationId] = useState('')
  const [mode, setMode] = useState<'sweep' | 'test'>('sweep')
  const [amount, setAmount] = useState('')
  const selected = destinationId || options[0]?.id || ''

  const preview = useMutation({
    mutationFn: (input: Parameters<typeof transactionsApi.preview>[0]) =>
      transactionsApi.preview(input),
    onSuccess: (tx) => navigate(`/transactions/${tx.id}`),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    preview.mutate({
      addressId: address.id,
      assetId: asset.assetId,
      destinationId: selected,
      amount: mode === 'test' ? amount.trim() : null,
    })
  }

  return (
    <form
      aria-label="Buat preview transaksi"
      onSubmit={submit}
      className="mt-4 space-y-3 border-t border-slate-200 pt-4"
    >
      <h3 className="text-sm font-semibold">Preview transaksi {asset.symbol}</h3>
      <p className="text-xs text-slate-500">
        Saldo, nonce, dan fee dibaca langsung dari jaringan saat ini. Hasilnya hanya draft (CREATED)
        yang harus di-approve REVIEWER lain; tidak ada yang dikirim.
      </p>
      {destinations.isSuccess && options.length === 0 ? (
        <p className="text-sm text-amber-700">Belum ada destination APPROVED di network ini.</p>
      ) : (
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Destination</span>
          <select
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={selected}
            onChange={(e) => setDestinationId(e.target.value)}
          >
            {options.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} — {d.address}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="sr-only">Jumlah</legend>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={mode === 'sweep'} onChange={() => setMode('sweep')} />
          Seluruh saldo (sweep)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={mode === 'test'} onChange={() => setMode('test')} />
          Test transfer kecil
        </label>
      </fieldset>
      {mode === 'test' && (
        <Field
          label={`Jumlah (${asset.symbol})`}
          inputMode="decimal"
          placeholder="0.001"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      )}
      <ErrorMessage error={preview.error} />
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={!selected || preview.isPending || (mode === 'test' && !amount.trim())}
        >
          {preview.isPending ? 'Membaca jaringan…' : 'Buat preview'}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Batal
        </Button>
      </div>
    </form>
  )
}
