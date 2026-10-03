import { useState, type FormEvent } from 'react'
import { ApiError, reauthApi } from '../services/api'
import { Button, ErrorMessage, Field } from './ui'

export interface SensitiveOptions {
  /**
   * Retry the action automatically after re-authentication (default true). Set false when the
   * action carries its own one-time code: re-authentication consumes the current TOTP step,
   * so a retry with the old code would always fail (and count as a wrong code).
   */
  retryAfterReauth?: boolean
  /** Called after a successful re-authentication when the action is NOT retried. */
  onReauthenticated?: () => void
}

interface Pending {
  action: () => Promise<void>
  options: SensitiveOptions
}

/**
 * Runs a sensitive action; when the server answers REAUTH_REQUIRED, asks for
 * password + authenticator code once and then retries the same action.
 */
export function useSensitive() {
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<unknown>(null)

  async function run(action: () => Promise<void>, options: SensitiveOptions = {}) {
    setError(null)
    try {
      await action()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REAUTH_REQUIRED') setPending({ action, options })
      else setError(err)
    }
  }

  const panel = pending ? (
    <ReauthPanel
      onCancel={() => setPending(null)}
      onConfirmed={async () => {
        const { action, options } = pending
        setPending(null)
        if (options.retryAfterReauth === false) options.onReauthenticated?.()
        else await run(action, options)
      }}
    />
  ) : null

  return { run, error, panel, clearError: () => setError(null) }
}

function ReauthPanel({
  onConfirmed,
  onCancel,
}: {
  onConfirmed: () => Promise<void>
  onCancel: () => void
}) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    // The panel may be rendered inside another form; its submit must not bubble up and
    // trigger that form's action as well.
    event.stopPropagation()
    setBusy(true)
    setError(null)
    try {
      await reauthApi.reauth(password, code)
      setPassword('')
      setCode('')
      await onConfirmed()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      aria-label="Konfirmasi identitas"
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4"
    >
      <p className="text-sm text-amber-900">
        Aksi sensitif membutuhkan konfirmasi ulang (berlaku 5 menit). Masukkan password akun dan
        kode authenticator.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Password akun"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          label="Kode authenticator"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <ErrorMessage error={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || code.length !== 6}>
          Konfirmasi
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Batal
        </Button>
      </div>
    </form>
  )
}
