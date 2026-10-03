import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import { useSensitive } from '../components/sensitive'
import { Badge, Button, ErrorMessage, Field } from '../components/ui'
import { hasBrowserWallet, sha256File, signWithBrowserWallet } from '../lib/wallet'
import {
  ApiError,
  ownershipApi,
  type AuthorizationStatus,
  type AuthorizationType,
  type OwnershipChallenge,
  type PublicAuthorization,
} from '../services/api'
import { ADDRESSES_KEY } from './AddressesPage'

export const AUTHORIZATIONS_KEY = ['authorizations'] as const

const TYPE_LABELS: Record<AuthorizationType, string> = {
  SELF: 'Milik sendiri',
  MANDATE: 'Kuasa / mandat',
  CONTRACT: 'Kontrak',
}

export function AuthorizationStatusBadge({ status }: { status: AuthorizationStatus }) {
  const tone =
    status === 'VERIFIED'
      ? 'green'
      : status === 'PENDING'
        ? 'amber'
        : status === 'REJECTED' || status === 'EXPIRED'
          ? 'red'
          : 'slate'
  return <Badge tone={tone}>{status}</Badge>
}

/** Authorization records and signed-challenge verification for one address (Phase 7c). */
export function OwnershipSection({
  addressId,
  archived,
}: {
  addressId: string
  archived: boolean
}) {
  const { can } = useAuth()
  const canVerify = can('ownership:verify') && !archived
  const list = useQuery({
    queryKey: [...AUTHORIZATIONS_KEY, 'address', addressId],
    queryFn: () => ownershipApi.forAddress(addressId),
  })

  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-semibold">Otorisasi & verifikasi kepemilikan</h2>
      <p className="mt-1 text-sm text-slate-600">
        Catat dasar hukum (milik sendiri, kuasa, atau kontrak), lalu buktikan kendali atas address
        dengan menandatangani challenge sekali pakai.
      </p>
      <ErrorMessage error={list.error} />
      {list.data?.length === 0 && (
        <p className="mt-3 text-sm text-slate-500">Belum ada data otorisasi.</p>
      )}
      <ul className="mt-3 space-y-3">
        {list.data?.map((a) => (
          <AuthorizationItem key={a.id} authorization={a} canVerify={canVerify} />
        ))}
      </ul>
      {canVerify && <CreateAuthorizationForm addressId={addressId} />}
    </section>
  )
}

function AuthorizationItem({
  authorization: a,
  canVerify,
}: {
  authorization: PublicAuthorization
  canVerify: boolean
}) {
  const [challenge, setChallenge] = useState<OwnershipChallenge | null>(null)
  const create = useMutation({
    mutationFn: () => ownershipApi.challenge(a.id),
    onSuccess: setChallenge,
  })
  const latest = a.challenges[0]

  return (
    <li className="rounded-md border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <AuthorizationStatusBadge status={a.status} />
        <span className="font-medium">{TYPE_LABELS[a.type]}</span>
        <span className="text-slate-600">{a.reference}</span>
      </div>
      <dl className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
        <div>
          Dokumen:{' '}
          {a.documentSha256 ? (
            <span title={a.documentSha256}>
              {a.documentName ?? 'tanpa nama'} · SHA-256{' '}
              <span className="font-mono">{a.documentSha256.slice(0, 12)}…</span>
            </span>
          ) : (
            '—'
          )}
        </div>
        <div>
          Berlaku sampai:{' '}
          {a.expiresAt ? new Date(a.expiresAt).toLocaleDateString('id-ID') : 'tanpa batas'}
        </div>
        <div>
          Terverifikasi: {a.verifiedAt ? new Date(a.verifiedAt).toLocaleString('id-ID') : '—'}
        </div>
        {latest && (
          <div>
            Challenge terakhir: {latest.result}
            {latest.method && ` (${latest.method})`} ·{' '}
            {new Date(latest.issuedAt).toLocaleString('id-ID')}
          </div>
        )}
      </dl>
      {canVerify && a.status !== 'EXPIRED' && !challenge && (
        <div className="mt-3">
          <Button variant="secondary" disabled={create.isPending} onClick={() => create.mutate()}>
            {a.status === 'VERIFIED' ? 'Verifikasi ulang' : 'Buat challenge verifikasi'}
          </Button>
        </div>
      )}
      <ErrorMessage error={create.error} />
      {challenge && <ChallengePanel challenge={challenge} onDone={() => setChallenge(null)} />}
    </li>
  )
}

function ChallengePanel({
  challenge,
  onDone,
}: {
  challenge: OwnershipChallenge
  onDone: () => void
}) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const sensitive = useSensitive()
  const [manual, setManual] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [verified, setVerified] = useState(false)

  async function finish(action: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      setVerified(true)
    } catch (err) {
      // Let useSensitive ask for re-authentication and retry the vault action.
      if (err instanceof ApiError && err.code === 'REAUTH_REQUIRED') throw err
      setError(err)
    } finally {
      setBusy(false)
      // Any outcome (verified, rejected, expired) changes what the server stores.
      await queryClient.invalidateQueries({ queryKey: AUTHORIZATIONS_KEY })
      await queryClient.invalidateQueries({ queryKey: ADDRESSES_KEY })
    }
  }

  if (verified) {
    return (
      <div className="mt-3 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
        Kepemilikan terverifikasi.{' '}
        <button type="button" className="underline" onClick={onDone}>
          Tutup
        </button>
      </div>
    )
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-slate-300 bg-slate-50 p-3">
      <p className="text-xs text-slate-600">
        Tanda tangani pesan berikut dengan address{' '}
        <span className="font-mono">{challenge.address}</span> sebelum{' '}
        {new Date(challenge.expiresAt).toLocaleTimeString('id-ID')}. Challenge hanya bisa dipakai
        sekali.
      </p>
      <pre
        aria-label="Pesan challenge"
        className="overflow-x-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-xs"
      >
        {challenge.message}
      </pre>
      <div className="flex flex-wrap gap-2">
        {hasBrowserWallet() && (
          <Button
            disabled={busy}
            onClick={() =>
              void finish(async () => {
                const signature = await signWithBrowserWallet(challenge.address, challenge.message)
                await ownershipApi.submitSignature(challenge.id, signature, 'WALLET')
              })
            }
          >
            Tanda tangani dengan wallet browser
          </Button>
        )}
        {can('vault:manage') && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void sensitive.run(() => finish(() => ownershipApi.vaultSign(challenge.id)))
            }
          >
            Tanda tangani dengan Key Vault
          </Button>
        )}
      </div>
      {sensitive.panel}
      <ErrorMessage error={sensitive.error} />
      <form
        aria-label="Tempel signature"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void finish(() => ownershipApi.submitSignature(challenge.id, manual.trim(), 'MANUAL'))
        }}
      >
        <div className="min-w-0 flex-1">
          <Field
            label="Signature (dari wallet lain / offline)"
            placeholder="0x…"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={busy || !manual.trim()}>
          Kirim signature
        </Button>
      </form>
      <ErrorMessage error={error} />
      <button type="button" className="text-xs text-slate-500 underline" onClick={onDone}>
        Batalkan
      </button>
    </div>
  )
}

function CreateAuthorizationForm({ addressId }: { addressId: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<AuthorizationType>('SELF')
  const [reference, setReference] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [document, setDocument] = useState<{ name: string; sha256: string } | null>(null)
  const [hashing, setHashing] = useState(false)

  // The payload is passed to mutate(): a closure over state could submit a stale document hash.
  const create = useMutation({
    mutationFn: (input: Parameters<typeof ownershipApi.create>[1]) =>
      ownershipApi.create(addressId, input),
    onSuccess: async () => {
      setOpen(false)
      setReference('')
      setExpiresOn('')
      setDocument(null)
      await queryClient.invalidateQueries({ queryKey: AUTHORIZATIONS_KEY })
      await queryClient.invalidateQueries({ queryKey: ADDRESSES_KEY })
    },
  })

  async function pickFile(file: File | undefined) {
    if (!file) return setDocument(null)
    setHashing(true)
    try {
      setDocument({ name: file.name, sha256: await sha256File(file) })
    } finally {
      setHashing(false)
    }
  }

  if (!open) {
    return (
      <div className="mt-4">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Tambah otorisasi
        </Button>
      </div>
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    create.mutate({
      type,
      reference: reference.trim(),
      documentSha256: document?.sha256 ?? null,
      documentName: document?.name ?? null,
      expiresAt: expiresOn ? new Date(`${expiresOn}T23:59:59`).toISOString() : null,
    })
  }

  return (
    <form
      aria-label="Tambah otorisasi"
      onSubmit={submit}
      className="mt-4 grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2"
    >
      <label className="block text-sm">
        <span className="font-medium text-slate-700">Jenis otorisasi</span>
        <select
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
          value={type}
          onChange={(e) => setType(e.target.value as AuthorizationType)}
        >
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <Field
        label="Referensi"
        hint="Nomor surat kuasa / kontrak, atau keterangan singkat."
        required
        maxLength={200}
        value={reference}
        onChange={(e) => setReference(e.target.value)}
      />
      <label className="block text-sm">
        <span className="font-medium text-slate-700">Dokumen pendukung (opsional)</span>
        <input
          type="file"
          className="mt-1 block w-full text-sm"
          onChange={(e) => void pickFile(e.target.files?.[0])}
        />
        <span className="mt-1 block text-xs text-slate-500">
          {hashing
            ? 'Menghitung SHA-256…'
            : document
              ? `SHA-256: ${document.sha256}`
              : 'Hanya sidik jari SHA-256 yang dikirim; file tidak diunggah.'}
        </span>
      </label>
      <Field
        label="Berlaku sampai (opsional)"
        type="date"
        value={expiresOn}
        onChange={(e) => setExpiresOn(e.target.value)}
      />
      <div className="sm:col-span-2">
        <ErrorMessage error={create.error} />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={create.isPending || hashing || !reference.trim()}>
          Simpan otorisasi
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Batal
        </Button>
      </div>
    </form>
  )
}
