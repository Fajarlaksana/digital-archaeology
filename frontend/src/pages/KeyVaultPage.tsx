import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Badge, Button, ErrorMessage, Field } from '../components/ui'
import { useSensitive } from '../components/sensitive'
import { addressesApi, vaultApi, type VaultKey, type VaultStatus } from '../services/api'

const VAULT_KEY = ['vault'] as const
const MIN_PASSPHRASE = 16
const REVEAL_SECONDS = 60

export function KeyVaultPage() {
  const status = useQuery({
    queryKey: [...VAULT_KEY, 'status'],
    queryFn: vaultApi.status,
    refetchInterval: 15_000,
  })
  const s = status.data

  return (
    <section className="max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Key Vault</h1>
        <p className="mt-1 text-slate-600">
          Private key disimpan terenkripsi di service signer terpisah dan hanya bisa dibuka dengan
          passphrase Anda. Passphrase tidak pernah disimpan, sehingga jika passphrase utama dan
          recovery passphrase hilang, key <strong>tidak bisa dipulihkan</strong>.
        </p>
      </header>
      <ErrorMessage error={status.error} />
      {s && <StatusBar status={s} />}
      {s && !s.initialized && <InitForm />}
      {s?.initialized && <LockControls status={s} />}
      {s?.initialized && <KeysSection unlocked={s.unlocked} />}
      {s?.initialized && <VaultSettings />}
    </section>
  )
}

function StatusBar({ status }: { status: VaultStatus }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const remaining = status.expiresAt
    ? Math.max(0, Math.floor((Date.parse(status.expiresAt) - now) / 1000))
    : 0
  return (
    <div
      role="status"
      aria-label="Status vault"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm"
    >
      {!status.initialized ? (
        <Badge tone="slate">Belum diinisialisasi</Badge>
      ) : status.unlocked ? (
        <>
          <Badge tone="amber">TERBUKA</Badge>
          <span>
            Terkunci otomatis dalam {Math.floor(remaining / 60)}:
            {String(remaining % 60).padStart(2, '0')}
          </span>
        </>
      ) : (
        <Badge tone="green">Terkunci</Badge>
      )}
      <span className="text-slate-500">Batas unlock: {status.unlockTtlMinutes} menit</span>
    </div>
  )
}

function useRefreshVault() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: VAULT_KEY })
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function passphraseProblem(value: string, confirm: string): string | null {
  if (value.length < MIN_PASSPHRASE)
    return `Minimal ${MIN_PASSPHRASE} karakter (misalnya 4–5 kata acak).`
  if (value !== confirm) return 'Konfirmasi tidak sama.'
  return null
}

function InitForm() {
  const refresh = useRefreshVault()
  const sensitive = useSensitive()
  const [form, setForm] = useState({ main: '', mainConfirm: '', recovery: '', recoveryConfirm: '' })
  const [acknowledged, setAcknowledged] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    const issue =
      passphraseProblem(form.main, form.mainConfirm) ??
      passphraseProblem(form.recovery, form.recoveryConfirm) ??
      (form.main === form.recovery
        ? 'Recovery passphrase harus berbeda dari passphrase utama.'
        : null)
    setProblem(issue)
    if (issue) return
    void sensitive.run(async () => {
      await vaultApi.init(form.main, form.recovery)
      setForm({ main: '', mainConfirm: '', recovery: '', recoveryConfirm: '' })
      await refresh()
    })
  }

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value })
  return (
    <Card title="Inisialisasi vault">
      <form aria-label="Inisialisasi vault" onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Passphrase utama"
            type="password"
            autoComplete="new-password"
            value={form.main}
            onChange={set('main')}
          />
          <Field
            label="Ulangi passphrase utama"
            type="password"
            autoComplete="new-password"
            value={form.mainConfirm}
            onChange={set('mainConfirm')}
          />
          <Field
            label="Recovery passphrase"
            type="password"
            autoComplete="new-password"
            hint="Tulis di kertas dan simpan di tempat fisik yang aman (brankas). Jangan di HP/cloud/foto."
            value={form.recovery}
            onChange={set('recovery')}
          />
          <Field
            label="Ulangi recovery passphrase"
            type="password"
            autoComplete="new-password"
            value={form.recoveryConfirm}
            onChange={set('recoveryConfirm')}
          />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          Saya sudah menyimpan recovery passphrase secara offline dan paham bahwa key tidak bisa
          dipulihkan jika kedua passphrase hilang.
        </label>
        {problem && (
          <p role="alert" className="text-sm text-red-700">
            {problem}
          </p>
        )}
        <ErrorMessage error={sensitive.error} />
        {sensitive.panel}
        <Button type="submit" disabled={!acknowledged}>
          Inisialisasi
        </Button>
      </form>
    </Card>
  )
}

function LockControls({ status }: { status: VaultStatus }) {
  const refresh = useRefreshVault()
  const sensitive = useSensitive()
  const [passphrase, setPassphrase] = useState('')

  if (status.unlocked) {
    return (
      <Button
        variant="secondary"
        onClick={() =>
          void sensitive.run(async () => {
            await vaultApi.lock()
            await refresh()
          })
        }
      >
        Kunci vault sekarang
      </Button>
    )
  }
  return (
    <Card title="Buka vault">
      <form
        aria-label="Buka vault"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void sensitive.run(async () => {
            await vaultApi.unlock(passphrase)
            setPassphrase('')
            await refresh()
          })
        }}
      >
        <div className="w-72">
          <Field
            label="Passphrase vault"
            type="password"
            autoComplete="off"
            required
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </div>
        <Button type="submit">Buka</Button>
      </form>
      <div className="mt-3 space-y-3">
        <ErrorMessage error={sensitive.error} />
        {sensitive.panel}
      </div>
    </Card>
  )
}

function KeysSection({ unlocked }: { unlocked: boolean }) {
  const keys = useQuery({ queryKey: [...VAULT_KEY, 'keys'], queryFn: vaultApi.keys })
  const [revealFor, setRevealFor] = useState<VaultKey | null>(null)

  return (
    <Card title="Key tersimpan">
      <ErrorMessage error={keys.error} />
      {keys.data?.length === 0 && <p className="text-sm text-slate-500">Belum ada key.</p>}
      {keys.data && keys.data.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Address</th>
              <th className="py-1">Inventaris</th>
              <th className="py-1">Jenis</th>
              <th className="py-1">Diimpor</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {keys.data.map((key) => (
              <tr key={key.address} className="border-t border-slate-100 align-top">
                <td className="py-1.5 font-mono text-xs">{key.checksumAddress}</td>
                <td className="py-1.5 text-xs">
                  {key.inventory.length === 0
                    ? 'tidak ada di inventaris'
                    : key.inventory
                        .map((i) => `${i.label ?? '—'} (${i.network.displayName})`)
                        .join(', ')}
                </td>
                <td className="py-1.5 text-xs">
                  {key.keyType === 'PRIVATE_KEY'
                    ? 'private key'
                    : `dari seed (${key.derivationPath})`}
                </td>
                <td className="py-1.5 text-xs">
                  {new Date(key.createdAt).toLocaleString('id-ID')}
                </td>
                <td className="py-1.5 text-right">
                  {key.inventory[0] && (
                    <Button variant="secondary" onClick={() => setRevealFor(key)}>
                      Tampilkan key
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {revealFor && <RevealDialog vaultKey={revealFor} onClose={() => setRevealFor(null)} />}
      {unlocked ? (
        <ImportForm existing={new Set(keys.data?.map((k) => k.address) ?? [])} />
      ) : (
        <p className="mt-4 text-sm text-slate-500">Buka vault untuk mengimpor key.</p>
      )}
    </Card>
  )
}

function ImportForm({ existing }: { existing: ReadonlySet<string> }) {
  const refresh = useRefreshVault()
  const sensitive = useSensitive()
  const addresses = useQuery({
    queryKey: ['addresses', 'vault-import'],
    queryFn: () => addressesApi.list({ pageSize: 200 }),
  })
  const candidates = (addresses.data?.items ?? []).filter(
    (a) => !existing.has(a.address.toLowerCase()),
  )
  const [addressId, setAddressId] = useState('')
  const [secretType, setSecretType] = useState<'PRIVATE_KEY' | 'MNEMONIC'>('PRIVATE_KEY')
  const [secret, setSecret] = useState('')
  const [path, setPath] = useState("m/44'/60'/0'/0/0")
  const [done, setDone] = useState<string | null>(null)
  const selected = addressId || candidates[0]?.id || ''

  function submit(event: FormEvent) {
    event.preventDefault()
    setDone(null)
    void sensitive.run(async () => {
      const { key } = await vaultApi.importKey({
        addressId: selected,
        secretType,
        secret,
        derivationPath: secretType === 'MNEMONIC' ? path : null,
      })
      setSecret('') // never keep the secret in UI state longer than needed
      setDone(key.address)
      await refresh()
    })
  }

  return (
    <form
      aria-label="Import key"
      onSubmit={submit}
      className="mt-6 space-y-3 border-t border-slate-100 pt-4"
    >
      <h3 className="text-sm font-semibold">Import key</h3>
      <p className="text-xs text-slate-500">
        Key harus mengendalikan address yang dipilih dari inventaris. Dari seed phrase, hanya
        private key pada derivation path yang disimpan; seed phrase tidak pernah disimpan.
      </p>
      <label className="block text-sm">
        <span className="font-medium text-slate-700">Address (inventaris)</span>
        <select
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
          value={selected}
          onChange={(e) => setAddressId(e.target.value)}
        >
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.address} — {a.label ?? 'tanpa label'} ({a.network.displayName})
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex gap-4 text-sm">
        <legend className="sr-only">Jenis input</legend>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={secretType === 'PRIVATE_KEY'}
            onChange={() => setSecretType('PRIVATE_KEY')}
          />
          Private key
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={secretType === 'MNEMONIC'}
            onChange={() => setSecretType('MNEMONIC')}
          />
          Seed phrase + derivation path
        </label>
      </fieldset>
      {secretType === 'PRIVATE_KEY' ? (
        <Field
          label="Private key (hex)"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      ) : (
        <>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Seed phrase</span>
            <textarea
              aria-label="Seed phrase"
              autoComplete="off"
              spellCheck={false}
              required
              rows={2}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <Field label="Derivation path" value={path} onChange={(e) => setPath(e.target.value)} />
        </>
      )}
      <ErrorMessage error={sensitive.error} />
      {sensitive.panel}
      {done && (
        <p role="status" className="text-sm text-emerald-700">
          Key untuk {done} tersimpan terenkripsi.
        </p>
      )}
      <Button type="submit" disabled={!selected || !secret}>
        Import
      </Button>
    </form>
  )
}

/** Break-glass reveal (ADR-009): passphrase + fresh code; masked by default; closes itself. */
function RevealDialog({ vaultKey, onClose }: { vaultKey: VaultKey; onClose: () => void }) {
  const sensitive = useSensitive()
  const [passphrase, setPassphrase] = useState('')
  const [code, setCode] = useState('')
  const [revealed, setRevealed] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_SECONDS)

  // Latest onClose without making it an effect dependency: a parent re-render must NOT
  // restart the 60-second timer (that would keep the key on screen longer).
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // While a key is shown: tick the countdown, and close for good after REVEAL_SECONDS.
  useEffect(() => {
    if (!revealed) return
    const tick = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000)
    const expire = setTimeout(() => {
      setRevealed(null)
      onCloseRef.current()
    }, REVEAL_SECONDS * 1000)
    return () => {
      clearInterval(tick)
      clearTimeout(expire)
    }
  }, [revealed])

  function close() {
    setRevealed(null) // drop the key from memory/state immediately
    setPassphrase('')
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tampilkan private key"
      className="mt-4 space-y-3 rounded-lg border-2 border-red-300 bg-red-50 p-4"
    >
      <p className="text-sm font-semibold text-red-900">
        Tampilkan private key — {vaultKey.checksumAddress}
      </p>
      {!revealed ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void sensitive.run(async () => {
              const result = await vaultApi.reveal(
                vaultKey.inventory[0]!.addressId,
                passphrase,
                code,
              )
              setPassphrase('')
              setCode('')
              setSecondsLeft(REVEAL_SECONDS)
              setRevealed(result.privateKey)
            })
          }}
        >
          <p className="text-sm text-red-900">
            Pastikan tidak ada orang lain atau software perekam layar. Setiap tampilan tercatat di
            audit log (maksimal 3 kali per jam).
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Passphrase vault"
              type="password"
              autoComplete="off"
              required
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <Field
              label="Kode authenticator"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <ErrorMessage error={sensitive.error} />
          {sensitive.panel}
          <div className="flex gap-2">
            <Button type="submit" disabled={code.length !== 6 || !passphrase}>
              Tampilkan
            </Button>
            <Button type="button" variant="secondary" onClick={close}>
              Batal
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-2">
          <code
            aria-label="Private key"
            className="block break-all rounded bg-white px-3 py-2 font-mono text-sm"
          >
            {visible ? revealed : '•'.repeat(66)}
          </code>
          <p className="text-xs text-red-900">Tertutup otomatis dalam {secondsLeft} detik.</p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setVisible((v) => !v)}>
              {visible ? 'Sembunyikan' : 'Lihat'}
            </Button>
            <Button onClick={close}>Tutup</Button>
          </div>
        </div>
      )}
    </div>
  )
}

function VaultSettings() {
  const refresh = useRefreshVault()
  const change = useSensitive()
  const recover = useSensitive()
  const [current, setCurrent] = useState({ old: '', next: '', confirm: '' })
  const [rec, setRec] = useState({ recovery: '', next: '', confirm: '' })
  const [message, setMessage] = useState<string | null>(null)

  return (
    <details className="rounded-lg border border-slate-200 bg-white p-4">
      <summary className="cursor-pointer font-semibold">Pengaturan passphrase</summary>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <form
          aria-label="Ganti passphrase"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            const issue = passphraseProblem(current.next, current.confirm)
            setMessage(issue)
            if (issue) return
            void change.run(async () => {
              await vaultApi.changePassphrase(current.old, current.next)
              setCurrent({ old: '', next: '', confirm: '' })
              setMessage('Passphrase utama diganti.')
              await refresh()
            })
          }}
        >
          <h3 className="text-sm font-semibold">Ganti passphrase utama</h3>
          <Field
            label="Passphrase saat ini"
            type="password"
            autoComplete="off"
            value={current.old}
            onChange={(e) => setCurrent({ ...current, old: e.target.value })}
          />
          <Field
            label="Passphrase baru"
            type="password"
            autoComplete="new-password"
            value={current.next}
            onChange={(e) => setCurrent({ ...current, next: e.target.value })}
          />
          <Field
            label="Ulangi passphrase baru"
            type="password"
            autoComplete="new-password"
            value={current.confirm}
            onChange={(e) => setCurrent({ ...current, confirm: e.target.value })}
          />
          <ErrorMessage error={change.error} />
          {change.panel}
          <Button type="submit">Ganti</Button>
        </form>
        <form
          aria-label="Pulihkan dengan recovery passphrase"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            const issue = passphraseProblem(rec.next, rec.confirm)
            setMessage(issue)
            if (issue) return
            void recover.run(async () => {
              await vaultApi.recover(rec.recovery, rec.next)
              setRec({ recovery: '', next: '', confirm: '' })
              setMessage('Passphrase utama baru sudah ditetapkan. Vault terkunci.')
              await refresh()
            })
          }}
        >
          <h3 className="text-sm font-semibold">Lupa passphrase utama</h3>
          <Field
            label="Recovery passphrase"
            type="password"
            autoComplete="off"
            value={rec.recovery}
            onChange={(e) => setRec({ ...rec, recovery: e.target.value })}
          />
          <Field
            label="Passphrase utama baru"
            type="password"
            autoComplete="new-password"
            value={rec.next}
            onChange={(e) => setRec({ ...rec, next: e.target.value })}
          />
          <Field
            label="Ulangi passphrase utama baru"
            type="password"
            autoComplete="new-password"
            value={rec.confirm}
            onChange={(e) => setRec({ ...rec, confirm: e.target.value })}
          />
          <ErrorMessage error={recover.error} />
          {recover.panel}
          <Button type="submit">Pulihkan</Button>
        </form>
      </div>
      {message && (
        <p role="status" className="mt-3 text-sm text-slate-700">
          {message}
        </p>
      )}
    </details>
  )
}
