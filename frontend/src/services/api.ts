export type HealthState = { ok: true; detail: string } | { ok: false; detail: string }

/** Calls a backend health endpoint and reduces the answer to ok / not ok. */
export async function checkHealth(
  path: '/health' | '/health/database' | '/health/rpc',
): Promise<HealthState> {
  try {
    const res = await fetch(path)
    const body: unknown = await res.json().catch(() => null)
    if (res.ok) {
      const status = (body as { status?: string } | null)?.status ?? 'ok'
      return { ok: status === 'ok', detail: status }
    }
    const code = (body as { error?: { code?: string } } | null)?.error?.code ?? `HTTP ${res.status}`
    return { ok: false, detail: code }
  } catch {
    return { ok: false, detail: 'tidak terhubung' }
  }
}
