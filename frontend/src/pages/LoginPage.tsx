import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { Button, ErrorMessage, Field } from '../components/ui'
import { authApi } from '../services/api'

export function LoginPage() {
  const { me, refresh } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [submitting, setSubmitting] = useState(false)

  if (me?.sessionState === 'ACTIVE') return <Navigate to="/" replace />

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const { sessionState } = await authApi.login(email, password)
      setPassword('')
      await refresh()
      navigate(sessionState === 'ACTIVE' ? '/' : '/mfa', { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthCard title="Masuk" subtitle="Digital Archaeology · Testnet">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorMessage error={error} />
        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? 'Memeriksa…' : 'Masuk'}
        </Button>
      </form>
    </AuthCard>
  )
}

export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <section className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </section>
    </div>
  )
}
