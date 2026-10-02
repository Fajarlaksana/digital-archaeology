import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { ApiError } from '../services/api'

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  const tone =
    variant === 'primary'
      ? 'bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-400'
      : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:text-slate-400'
  return (
    <button
      className={`rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed ${tone} ${className}`}
      {...props}
    />
  )
}

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <input
        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
        {...props}
      />
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  )
}

/** Shows an API error message; the request id helps match it to server logs. */
export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null
  const message = error instanceof Error ? error.message : 'Terjadi kesalahan'
  const requestId = error instanceof ApiError ? error.requestId : null
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
      {requestId && <span className="block text-xs text-red-500">Request ID: {requestId}</span>}
    </p>
  )
}
