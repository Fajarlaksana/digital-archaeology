import { useState } from 'react'
import { hasBrowserWallet, signWithBrowserWallet } from '../lib/wallet'
import { ApiError } from '../services/api'
import { useSensitive } from './sensitive'
import { Button, ErrorMessage, Field } from './ui'

export interface ChallengeToSign {
  id: string
  address: string
  message: string
  expiresAt: string
}

/**
 * Shows a single-use challenge and the ways to sign it: the browser wallet, a pasted
 * signature from another device, and (optionally) the Key Vault. Used for ownership
 * verification (Phase 7c) and destination proof of control (Phase 8a).
 */
export function SignChallengePanel({
  challenge,
  submit,
  vaultSign,
  successText,
  onSettled,
  onDone,
}: {
  challenge: ChallengeToSign
  submit: (signature: string, method: 'WALLET' | 'MANUAL') => Promise<unknown>
  /** Only passed when the user may sign with the vault (SUPER_ADMIN). */
  vaultSign?: () => Promise<unknown>
  successText: string
  /** Runs after every attempt: verified, rejected and expired all change server state. */
  onSettled: () => Promise<void>
  onDone: () => void
}) {
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
      await onSettled()
    }
  }

  if (verified) {
    return (
      <div className="mt-3 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
        {successText}{' '}
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
                await submit(signature, 'WALLET')
              })
            }
          >
            Tanda tangani dengan wallet browser
          </Button>
        )}
        {vaultSign && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void sensitive.run(() => finish(vaultSign))}
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
          void finish(() => submit(manual.trim(), 'MANUAL'))
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
