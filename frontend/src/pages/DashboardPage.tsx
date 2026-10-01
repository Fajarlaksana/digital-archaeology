import { useEffect, useState } from 'react'
import { checkHealth, type HealthState } from '../services/api'

const CHECKS = [
  { path: '/health', label: 'Backend' },
  { path: '/health/database', label: 'Database' },
  { path: '/health/rpc', label: 'RPC' },
] as const

type Results = Partial<Record<(typeof CHECKS)[number]['path'], HealthState>>

export function DashboardPage() {
  const [results, setResults] = useState<Results>({})

  useEffect(() => {
    let cancelled = false
    for (const check of CHECKS) {
      void checkHealth(check.path).then((state) => {
        if (!cancelled) setResults((prev) => ({ ...prev, [check.path]: state }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-1 text-slate-600">
        Kartu ringkasan aset dibangun di Fase 6. Untuk sekarang: status koneksi sistem.
      </p>
      <ul className="mt-6 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
        {CHECKS.map((check) => {
          const state = results[check.path]
          const tone = !state
            ? 'border-slate-200 text-slate-500'
            : state.ok
              ? 'border-emerald-300 text-emerald-700'
              : 'border-amber-300 text-amber-700'
          return (
            <li key={check.path} className={`rounded-lg border bg-white p-4 ${tone}`}>
              <p className="text-sm font-medium text-slate-900">{check.label}</p>
              <p className="mt-1 text-sm">{state ? state.detail : 'memeriksa…'}</p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
