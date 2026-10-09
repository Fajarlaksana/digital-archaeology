import type { Logger } from '@da/shared'
import type { Notifier } from '../lib/notifier'
import type { AuditEntry, AuditLogRepository } from '../repositories/audit-log.repository'

/**
 * Which audited events also raise an alert (Phase 13b, ADR-027), with a human label.
 * `when` narrows it (e.g. only a FAILED integrity check).
 */
const ALERTS: Record<string, { label: string; when?: (entry: AuditEntry) => boolean }> = {
  VAULT_UNLOCKED: { label: 'Vault dibuka' },
  VAULT_UNLOCKED_FAILED: { label: 'Percobaan buka vault GAGAL' },
  VAULT_RECOVERED: { label: 'Vault dipulihkan dengan recovery passphrase' },
  KEY_IMPORTED: { label: 'Key di-import ke vault' },
  KEY_REVEALED: { label: 'Private key DITAMPILKAN (break-glass)' },
  KEY_REVEALED_FAILED: { label: 'Percobaan reveal key GAGAL' },
  TX_SIGNED: { label: 'Transaksi ditandatangani' },
  TX_SIGNATURE_REJECTED: { label: 'Signature transaksi DITOLAK verifier' },
  TX_BROADCASTED: { label: 'Transaksi di-broadcast' },
  TX_CONFIRMED: { label: 'Transaksi CONFIRMED' },
  TX_FAILED: { label: 'Transaksi FAILED di jaringan' },
  TX_STUCK: { label: 'Transaksi STUCK (belum masuk blok)' },
  ACCOUNT_LOCKED: { label: 'Akun terkunci karena password salah berulang' },
  MFA_RESET: { label: 'MFA user direset oleh ADMIN' },
  AUDIT_CHAIN_VERIFIED: {
    label: 'RANTAI AUDIT RUSAK',
    when: (entry) => entry.metadata?.ok === false,
  },
}

/** Only these metadata fields may appear in a notification (all public or non-secret). */
const SAFE_FIELDS = [
  'address',
  'network',
  'txHash',
  'code',
  'reason',
  'confirmations',
  'firstBrokenSequence',
] as const

export function alertText(
  entry: AuditEntry,
  context: { actor: string | null; environment: string; at: Date },
): string | null {
  const alert = ALERTS[entry.action]
  if (!alert || (alert.when && !alert.when(entry))) return null
  const details = SAFE_FIELDS.flatMap((field) => {
    const value = entry.metadata?.[field]
    if (value === undefined || value === null || typeof value === 'object') return []
    // `reason` is only forwarded when it is a machine code (e.g. REVERTED): free-text reasons,
    // such as an ADMIN's identity-verification note on MFA_RESET, may contain personal data.
    if (field === 'reason' && !/^[A-Z][A-Z0-9_]{1,63}$/.test(String(value))) return []
    return [`${field}: ${String(value).slice(0, 200)}`]
  })
  return [
    `[Digital Archaeology · ${context.environment}] ${alert.label}`,
    `Aksi: ${entry.action} (${entry.result})`,
    `Oleh: ${context.actor ?? 'sistem'}`,
    `Waktu: ${context.at.toISOString()}`,
    ...(entry.resourceType
      ? [`Resource: ${entry.resourceType} ${entry.resourceId ?? ''}`.trim()]
      : []),
    ...details,
  ].join('\n')
}

/**
 * Wraps the audit repository: whatever is audited and listed in ALERTS is also sent to the
 * notifier — so an alert can never be forgotten in one code path. Sending happens after the
 * audit row is written and never fails or delays the action that triggered it.
 */
export function withAlerts(
  audit: AuditLogRepository,
  deps: {
    notifier: Notifier
    environment: string
    emailOf: (userId: string) => Promise<string | null>
    logger: Logger
    now: () => Date
  },
): AuditLogRepository {
  return {
    ...audit,
    async create(entry) {
      const row = await audit.create(entry)
      if (ALERTS[entry.action]) {
        void (async () => {
          const actor = entry.userId ? await deps.emailOf(entry.userId) : null
          const text = alertText(entry, { actor, environment: deps.environment, at: deps.now() })
          if (text) await deps.notifier.send(text)
        })().catch(() => deps.logger.warn({ action: entry.action }, 'NOTIFICATION_FAILED'))
      }
      return row
    },
  }
}
