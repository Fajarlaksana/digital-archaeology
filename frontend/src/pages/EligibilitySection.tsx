import { useQuery } from '@tanstack/react-query'
import { Badge, ErrorMessage } from '../components/ui'
import { RecoveryBadge, REASONS, reasonLabel } from '../eligibility'
import { eligibilityApi, formatFiat, type PublicAddress } from '../services/api'
import { ADDRESSES_KEY } from './AddressesPage'

/** Per-asset eligibility of one address (Phase 8b). Information only — nothing is moved. */
export function EligibilitySection({ address: a }: { address: PublicAddress }) {
  const assets = useQuery({
    queryKey: [...ADDRESSES_KEY, 'eligibility', a.id],
    queryFn: () => eligibilityApi.forAddress(a.id),
  })

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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
