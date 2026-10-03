import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import { useSensitive } from '../components/sensitive'
import { SignChallengePanel } from '../components/SignChallengePanel'
import { Badge, Button, ErrorMessage, Field } from '../components/ui'
import {
  destinationsApi,
  networksApi,
  type DestinationStatus,
  type OwnershipChallenge,
  type PublicDestination,
} from '../services/api'
import { NETWORKS_KEY } from './NetworksPage'

export const DESTINATIONS_KEY = ['destinations'] as const

const STATUS_LABEL: Record<DestinationStatus, string> = {
  PENDING_APPROVAL: 'Menunggu approval',
  APPROVED: 'Approved',
  REJECTED: 'Ditolak',
  DISABLED: 'Nonaktif',
}

function StatusBadge({ status }: { status: DestinationStatus }) {
  const tone =
    status === 'APPROVED'
      ? 'green'
      : status === 'PENDING_APPROVAL'
        ? 'amber'
        : status === 'REJECTED'
          ? 'red'
          : 'slate'
  return <Badge tone={tone}>{STATUS_LABEL[status]}</Badge>
}

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString('id-ID') : '—')

/**
 * Destination whitelist (Phase 8a, ADR-020): wallets that recovered assets may be sent to.
 * A destination needs a signed proof of control AND approval by an independent REVIEWER.
 */
export function DestinationsPage() {
  const { can } = useAuth()
  const [status, setStatus] = useState<DestinationStatus | ''>('')
  const list = useQuery({
    queryKey: [...DESTINATIONS_KEY, status],
    queryFn: () => destinationsApi.list(status || undefined),
  })

  return (
    <section className="max-w-5xl">
      <h1 className="text-xl font-semibold">Destinations</h1>
      <p className="mt-1 text-sm text-slate-600">
        Wallet tujuan yang boleh menerima aset hasil recovery. Setiap destination wajib dibuktikan
        dengan tanda tangan dari address tujuan, lalu di-approve REVIEWER yang tidak terlibat dalam
        pengajuannya.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Status</span>
          <select
            className="mt-1 block rounded-md border border-slate-300 px-2 py-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as DestinationStatus | '')}
          >
            <option value="">Semua</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {can('destinations:create') && <CreateDestinationForm />}
      <ErrorMessage error={list.error} />
      {list.data?.length === 0 && (
        <p className="mt-6 text-sm text-slate-500">Belum ada destination.</p>
      )}
      <ul className="mt-4 space-y-3">
        {list.data?.map((d) => (
          <DestinationCard key={d.id} destination={d} />
        ))}
      </ul>
    </section>
  )
}

function CreateDestinationForm() {
  const queryClient = useQueryClient()
  const networks = useQuery({ queryKey: NETWORKS_KEY, queryFn: networksApi.list })
  const active = networks.data?.filter((n) => n.status === 'ACTIVE') ?? []
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ networkId: '', address: '', label: '' })
  const networkId = form.networkId || active[0]?.id || ''

  const create = useMutation({
    mutationFn: (input: { networkId: string; address: string; label: string }) =>
      destinationsApi.create(input),
    onSuccess: async () => {
      setOpen(false)
      setForm({ networkId: '', address: '', label: '' })
      await queryClient.invalidateQueries({ queryKey: DESTINATIONS_KEY })
    },
  })

  if (!open) {
    return (
      <div className="mt-4">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Tambah destination
        </Button>
      </div>
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    create.mutate({ networkId, address: form.address.trim(), label: form.label.trim() })
  }

  return (
    <form
      aria-label="Tambah destination"
      onSubmit={submit}
      className="mt-4 grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-3"
    >
      <label className="block text-sm">
        <span className="font-medium text-slate-700">Network</span>
        <select
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
          value={networkId}
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
        label="Address tujuan"
        required
        spellCheck={false}
        autoComplete="off"
        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
        value={form.address}
        onChange={(e) => setForm({ ...form, address: e.target.value })}
      />
      <Field
        label="Label"
        required
        maxLength={100}
        value={form.label}
        onChange={(e) => setForm({ ...form, label: e.target.value })}
      />
      <div className="sm:col-span-3">
        <ErrorMessage error={create.error} />
      </div>
      <div className="flex gap-2 sm:col-span-3">
        <Button
          type="submit"
          disabled={create.isPending || !networkId || !form.address.trim() || !form.label.trim()}
        >
          Simpan
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Batal
        </Button>
      </div>
    </form>
  )
}

function DestinationCard({ destination: d }: { destination: PublicDestination }) {
  const { can, me } = useAuth()
  const queryClient = useQueryClient()
  const sensitive = useSensitive()
  const [challenge, setChallenge] = useState<OwnershipChallenge | null>(null)
  const [reasonFor, setReasonFor] = useState<'reject' | 'disable' | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: DESTINATIONS_KEY })

  const open = d.approvals.find((a) => a.decision === null)
  const involved = [open?.requestedBy?.id, d.createdBy?.id, d.controlVerifiedBy?.id]
  const isInvolved = me !== null && involved.includes(me.user.id)
  const pending = d.status === 'PENDING_APPROVAL'
  const canDecide = can('destinations:approve') && !isInvolved

  async function act(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
      setReasonFor(null)
      setReason('')
      await refresh()
    } catch (err) {
      setError(err)
    }
  }

  // Decisions need a recent re-authentication: useSensitive asks and retries.
  const decide = (action: () => Promise<unknown>) =>
    sensitive.run(async () => {
      await action()
      setReasonFor(null)
      setReason('')
      await refresh()
    })

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{d.label}</span>
        <StatusBadge status={d.status} />
        <span className="text-slate-600">{d.network.displayName}</span>
        {d.network.isTestnet && <Badge tone="blue">TESTNET</Badge>}
      </div>
      <p className="mt-1 break-all font-mono text-xs">{d.address}</p>
      <dl className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
        <div>
          Bukti kendali:{' '}
          {d.controlVerifiedAt ? (
            <span className="text-emerald-700">
              terverifikasi ({d.controlVerifiedBy?.name ?? '—'}, {date(d.controlVerifiedAt)})
            </span>
          ) : (
            <span className="text-amber-700">belum dibuktikan</span>
          )}
        </div>
        <div>
          Diajukan: {d.createdBy?.name ?? '—'}, {date(d.createdAt)}
        </div>
        {d.statusReason && <div className="sm:col-span-2">Alasan: {d.statusReason}</div>}
      </dl>
      {d.approvals.some((a) => a.decision) && (
        <ul aria-label="Riwayat keputusan" className="mt-2 space-y-0.5 text-xs text-slate-500">
          {d.approvals
            .filter((a) => a.decision)
            .map((a) => (
              <li key={a.id}>
                {a.decision === 'APPROVED' ? 'Approved' : 'Ditolak'} oleh {a.decidedBy?.name ?? '—'}{' '}
                ({date(a.decidedAt)}){a.reason ? ` — ${a.reason}` : ''}
              </li>
            ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {pending && !d.controlVerifiedAt && can('destinations:create') && !challenge && (
          <Button
            variant="secondary"
            onClick={() =>
              void act(async () => setChallenge(await destinationsApi.challenge(d.id)))
            }
          >
            Buktikan kendali
          </Button>
        )}
        {pending && canDecide && (
          <>
            <Button
              disabled={!d.controlVerifiedAt}
              title={d.controlVerifiedAt ? undefined : 'Menunggu bukti kendali'}
              onClick={() => void decide(() => destinationsApi.approve(d.id, null))}
            >
              Approve
            </Button>
            <Button variant="secondary" onClick={() => setReasonFor('reject')}>
              Tolak
            </Button>
          </>
        )}
        {d.status === 'APPROVED' && canDecide && (
          <Button variant="secondary" onClick={() => setReasonFor('disable')}>
            Nonaktifkan
          </Button>
        )}
        {(d.status === 'REJECTED' || d.status === 'DISABLED') && can('destinations:create') && (
          <Button
            variant="secondary"
            onClick={() => void act(() => destinationsApi.resubmit(d.id))}
          >
            Ajukan ulang
          </Button>
        )}
      </div>
      {can('destinations:approve') && isInvolved && pending && (
        <p className="mt-2 text-xs text-slate-500">
          Anda terlibat dalam pengajuan atau pembuktian destination ini, jadi keputusannya harus
          diambil REVIEWER lain.
        </p>
      )}
      {pending && can('destinations:approve') && !d.controlVerifiedAt && !isInvolved && (
        <p className="mt-2 text-xs text-slate-500">
          Approve tersedia setelah pemilik address tujuan membuktikan kendali.
        </p>
      )}

      {reasonFor && (
        <form
          aria-label={reasonFor === 'reject' ? 'Tolak destination' : 'Nonaktifkan destination'}
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void decide(() =>
              reasonFor === 'reject'
                ? destinationsApi.reject(d.id, reason.trim())
                : destinationsApi.disable(d.id, reason.trim()),
            )
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
            {reasonFor === 'reject' ? 'Tolak' : 'Nonaktifkan'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setReasonFor(null)}>
            Batal
          </Button>
        </form>
      )}
      {sensitive.panel}
      <ErrorMessage error={sensitive.error} />
      <ErrorMessage error={error} />
      {challenge && (
        <SignChallengePanel
          challenge={challenge}
          submit={(signature, method) =>
            destinationsApi.submitSignature(challenge.id, signature, method)
          }
          successText="Kendali atas address tujuan terbukti."
          onSettled={refresh}
          onDone={() => setChallenge(null)}
        />
      )}
    </li>
  )
}
