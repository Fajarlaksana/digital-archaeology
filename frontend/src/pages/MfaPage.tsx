import { toDataURL } from 'qrcode'
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { Button, ErrorMessage, Field } from '../components/ui'
import { authApi } from '../services/api'
import { AuthCard } from './LoginPage'

/** Second factor: verify an existing authenticator, or enrol one on first login. */
export function MfaPage() {
  const { me, isLoading, refresh, logout } = useAuth()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [submitting, setSubmitting] = useState(false)
  const [enrolment, setEnrolment] = useState<{ secret: string; qr: string } | null>(null)

  if (isLoading) return null
  if (!me) return <Navigate to="/login" replace />
  if (me.sessionState === 'ACTIVE') return <Navigate to="/" replace />

  const setupMode = me.sessionState === 'MFA_SETUP_REQUIRED'

  async function startSetup() {
    setError(null)
    try {
      const { secret, otpauthUri } = await authApi.startMfaSetup()
      setEnrolment({ secret, qr: await toDataURL(otpauthUri, { margin: 1, width: 192 }) })
    } catch (err) {
      setError(err)
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await (setupMode ? authApi.enableMfa(code) : authApi.verifyMfa(code))
      setEnrolment(null)
      await refresh()
      navigate('/', { replace: true })
    } catch (err) {
      setError(err)
      setCode('')
      await refresh() // the session may have been revoked after too many attempts
    } finally {
      setSubmitting(false)
    }
  }

  const codeForm = (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field
        label="Kode 6 digit dari aplikasi authenticator"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      />
      <ErrorMessage error={error} />
      <Button type="submit" disabled={submitting || code.length !== 6} className="w-full">
        {submitting ? 'Memeriksa…' : setupMode ? 'Aktifkan MFA' : 'Verifikasi'}
      </Button>
    </form>
  )

  return (
    <AuthCard
      title={setupMode ? 'Aktifkan verifikasi dua langkah' : 'Verifikasi dua langkah'}
      subtitle={me.user.email}
    >
      {setupMode && !enrolment && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Role Anda ({me.user.roles.join(', ')}) wajib memakai aplikasi authenticator (Google
            Authenticator, Aegis, 1Password, dll.) sebelum dapat memakai sistem.
          </p>
          <ErrorMessage error={error} />
          <Button onClick={startSetup} className="w-full">
            Mulai setup
          </Button>
        </div>
      )}

      {setupMode && enrolment && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Pindai QR ini dengan aplikasi authenticator:</p>
          <img src={enrolment.qr} alt="QR code MFA" className="mx-auto h-48 w-48" />
          <p className="text-xs text-slate-500">
            Tidak bisa memindai? Masukkan kunci ini secara manual:
            <code className="mt-1 block break-all rounded bg-slate-100 px-2 py-1 font-mono text-slate-800">
              {enrolment.secret}
            </code>
          </p>
          {codeForm}
        </div>
      )}

      {!setupMode && codeForm}

      <button
        type="button"
        onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
        className="mt-4 w-full text-center text-sm text-slate-500 hover:text-slate-800"
      >
        Batal & keluar
      </button>
    </AuthCard>
  )
}
