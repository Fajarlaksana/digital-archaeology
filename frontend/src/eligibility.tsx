import { Badge } from './components/ui'
import type { RecoveryStatus } from './services/api'

/** Human text for eligibility reason codes (backend domain/eligibility.ts, ADR-021). */
export const REASONS: Record<string, { label: string; action: string }> = {
  STALE_BALANCE: { label: 'Saldo sudah lama', action: 'Jalankan scan ulang' },
  NO_BALANCE: { label: 'Tidak ada saldo', action: 'Tidak ada yang perlu dipulihkan' },
  AUTH_NOT_VERIFIED: {
    label: 'Kepemilikan belum terverifikasi',
    action: 'Tambah otorisasi dan verifikasi di detail address',
  },
  AUTH_EXPIRED: {
    label: 'Otorisasi kedaluwarsa',
    action: 'Tambah otorisasi baru lalu verifikasi ulang',
  },
  NO_APPROVED_DESTINATION: {
    label: 'Belum ada destination approved',
    action: 'Tambah destination, buktikan kendali, minta approval',
  },
  NO_KEY_IN_VAULT: { label: 'Key belum ada di vault', action: 'SUPER_ADMIN meng-import key' },
  SIGNER_UNAVAILABLE: {
    label: 'Vault tidak bisa dihubungi',
    action: 'Hubungi pengelola server, lalu hitung ulang',
  },
  NO_PRICE: { label: 'Harga tidak tersedia', action: 'ADMIN mengatur price id / refresh harga' },
  FEE_UNAVAILABLE: { label: 'Fee tidak bisa diestimasi', action: 'Periksa RPC, lalu hitung ulang' },
  FEE_EXCEEDS_BALANCE: { label: 'Fee melebihi saldo', action: 'Biarkan' },
  BELOW_MINIMUM: {
    label: 'Nilai bersih di bawah minimum',
    action: 'Biarkan, atau tunggu fee turun',
  },
  NEEDS_GAS_FUNDING: {
    label: 'Perlu dana gas',
    action: 'Keputusan manual: top-up gas atau abaikan',
  },
}

export const reasonLabel = (code: string) => REASONS[code]?.label ?? code

const STATUS: Record<
  RecoveryStatus,
  { label: string; tone: 'green' | 'amber' | 'red' | 'slate' | 'blue' }
> = {
  NONE: { label: 'Belum dinilai', tone: 'slate' },
  READY: { label: 'READY', tone: 'green' },
  NOT_ECONOMIC: { label: 'NOT_ECONOMIC', tone: 'amber' },
  NOT_ELIGIBLE: { label: 'NOT_ELIGIBLE', tone: 'red' },
  IN_PROGRESS: { label: 'IN_PROGRESS', tone: 'blue' },
  TRANSFERRED: { label: 'TRANSFERRED', tone: 'blue' },
}

export function RecoveryBadge({ status }: { status: RecoveryStatus }) {
  const s = STATUS[status]
  return <Badge tone={s.tone}>{s.label}</Badge>
}
