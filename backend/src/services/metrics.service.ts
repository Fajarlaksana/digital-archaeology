import type { Database } from '../lib/prisma'

/**
 * Prometheus metrics (SA 10, Phase 13b, ADR-027). Business numbers are read from the database at
 * scrape time (correct across instances and restarts); only HTTP request counts live in process.
 * Labels never carry ids, addresses or user data — route PATTERNS only.
 */
type Labels = Record<string, string>

const escape = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
const labelText = (labels: Labels) => {
  const entries = Object.entries(labels)
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${escape(v)}"`).join(',')}}` : ''
}

export function createMetricsService(deps: { db: Database }) {
  const http = new Map<string, { labels: Labels; count: number }>()

  return {
    /** Called from an onResponse hook with the route pattern (e.g. /api/transactions/:id). */
    countRequest(method: string, route: string, status: number) {
      const labels = { method, route, status: String(status) }
      const key = labelText(labels)
      const entry = http.get(key)
      if (entry) entry.count++
      else http.set(key, { labels, count: 1 })
    },

    async render(): Promise<string> {
      const { db } = deps
      const [scans, durations, activity, verified, scanned, transactions, rpcErrors] =
        await Promise.all([
          db.scan.groupBy({ by: ['status'], _count: { _all: true } }),
          db.$queryRaw<Array<{ avg: number | null }>>`
            SELECT avg(extract(epoch FROM ("completed_at" - "started_at")))::float8 AS avg
              FROM "scans" WHERE "status" = 'COMPLETED' AND "started_at" IS NOT NULL
               AND "completed_at" IS NOT NULL`,
          db.address.groupBy({
            by: ['activityStatus'],
            where: { archivedAt: null },
            _count: { _all: true },
          }),
          db.address.count({ where: { archivedAt: null, authorizationStatus: 'VERIFIED' } }),
          db.address.count({ where: { archivedAt: null, lastScannedAt: { not: null } } }),
          db.transaction.groupBy({ by: ['status'], _count: { _all: true } }),
          db.scanResult.count({ where: { errorCode: { not: null } } }),
        ])

      const out: string[] = []
      const metric = (
        name: string,
        type: 'counter' | 'gauge',
        help: string,
        samples: Array<[Labels, number]>,
      ) => {
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
        for (const [labels, value] of samples) out.push(`${name}${labelText(labels)} ${value}`)
      }

      metric(
        'da_scans',
        'gauge',
        'Scans by status (scan_count / scan_success_count / scan_failure_count).',
        scans.map((s) => [{ status: s.status }, s._count._all]),
      )
      metric('da_scan_duration_seconds_avg', 'gauge', 'Average duration of completed scans.', [
        [{}, Number(durations[0]?.avg ?? 0)],
      ])
      metric(
        'da_addresses',
        'gauge',
        'Active (not archived) addresses by activity status (inactive_addresses).',
        activity.map((a) => [{ activity_status: a.activityStatus }, a._count._all]),
      )
      metric('da_addresses_verified', 'gauge', 'Addresses with verified ownership.', [
        [{}, verified],
      ])
      metric('da_addresses_scanned', 'gauge', 'Addresses scanned at least once.', [[{}, scanned]])
      metric(
        'da_transactions',
        'gauge',
        'Recovery transactions by status (created / confirmed / failed).',
        transactions.map((t) => [{ status: t.status }, t._count._all]),
      )
      metric(
        'da_rpc_errors_total',
        'counter',
        'Per-address scan reads that failed (RPC/explorer).',
        [[{}, rpcErrors]],
      )
      metric(
        'da_http_requests_total',
        'counter',
        'HTTP requests handled by this instance, by route pattern.',
        [...http.values()].map((h) => [h.labels, h.count]),
      )
      metric('da_process_uptime_seconds', 'gauge', 'Seconds since this instance started.', [
        [{}, Math.round(process.uptime())],
      ])
      return `${out.join('\n')}\n`
    },
  }
}

export type MetricsService = ReturnType<typeof createMetricsService>
