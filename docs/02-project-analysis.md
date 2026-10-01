# 02 — Analisa Projek

Dokumen ini meninjau [system_analysis_digital_archaeology.md](../system_analysis_digital_archaeology.md) (selanjutnya disebut **SA**). Isinya: apa yang sudah kuat, celah yang harus ditutup sebelum coding, revisi desain, dan daftar risiko.

---

## 1. Ringkasan penilaian

| Aspek | Penilaian | Catatan |
|-------|-----------|---------|
| Tujuan & batasan etika | ✅ Kuat | Batasan jelas, "inactivity ≠ ownership" sudah ditegaskan |
| Modul & alur | ✅ Kuat | Alur Discover → Audit sudah benar |
| Sumber data blockchain | ⚠️ Kurang | RPC biasa **tidak bisa** memberi "transaksi terakhir" sebuah address (lihat 2.1) |
| Model status | ⚠️ Kurang | Satu kolom `status` mencampur 4 konsep berbeda (lihat 2.2) |
| Desain database | ⚠️ Kurang | Belum ada tabel user, approval, challenge, destination, dan histori scan |
| Model signing | ✅ Diputuskan | Key dipegang SUPER_ADMIN di vault terenkripsi (lihat 2.5, ADR-003/008/009) |
| Perbedaan chain | ⚠️ Belum dibahas | Model account (EVM) dan UTXO (Bitcoin) sangat berbeda |
| Approval workflow | ⚠️ Kurang detail | Belum ada aturan maker-checker (pembuat ≠ penyetuju) |
| Keamanan & logging | ✅ Baik | Perlu ditambah redaction otomatis dan audit log append-only |
| Testing | ✅ Baik | Perlu ditambah test "secret tidak bocor" |

**Kesimpulan:** SA sudah layak dijadikan dasar. Sebelum Fase 2 (database), perlu 6 revisi di bawah ini.

---

## 2. Celah dan revisi

### 2.1 Data "aktivitas terakhir" tidak tersedia lewat RPC standar

**Masalah.** JSON-RPC (`eth_getBalance`, `eth_getTransactionCount`) hanya memberi saldo dan jumlah transaksi **keluar** (nonce). Tidak ada method "kapan terakhir address ini bertransaksi", dan transaksi **masuk** sama sekali tidak terlihat.

**Revisi.**
- Scanner memakai dua sumber data:
  - **RPC node** untuk saldo dan nonce (sumber kebenaran).
  - **Explorer / indexer API** untuk riwayat dan timestamp transaksi terakhir (contoh: Etherscan-compatible API untuk EVM, Esplora/mempool.space untuk Bitcoin).
- Buat interface `ActivityProvider` terpisah dari `BalanceProvider` agar provider bisa diganti.
- Simpan `last_incoming_at`, `last_outgoing_at`, dan `last_activity_at` secara terpisah (SA 4.3 sudah meminta perbedaan ini).
- Saldo token ERC-20 dibaca per kontrak dari daftar token yang dikonfigurasi di tabel `assets`. Sistem tidak menebak token yang tidak dikenal.

### 2.2 Satu kolom `status` mencampur banyak konsep

**Masalah.** `ACTIVE, INACTIVE, NO_BALANCE, REQUIRES_REVIEW, AUTHORIZED, READY, TRANSFERRED` sebenarnya menggabungkan 4 dimensi berbeda. Satu address bisa sekaligus `INACTIVE` dan `AUTHORIZED`.

**Revisi.** Pecah menjadi beberapa kolom status yang independen:

```text
activity_status       : UNKNOWN | ACTIVE | INACTIVE
balance_status        : UNKNOWN | EMPTY | HAS_BALANCE
authorization_status  : UNVERIFIED | PENDING | VERIFIED | REJECTED | EXPIRED
recovery_status       : NONE | NOT_ELIGIBLE | NOT_ECONOMIC | READY | IN_PROGRESS | TRANSFERRED
review_flag           : boolean (REQUIRES_REVIEW)
```

### 2.3 Tabel yang belum ada

| Tabel baru | Fungsi |
|------------|--------|
| `users` | Akun login (password hash, MFA secret terenkripsi, status) |
| `user_roles` | Relasi user ↔ role (satu user bisa punya beberapa role) |
| `ownership_challenges` | Pesan challenge: `nonce`, `message`, `expires_at`, `used_at`, `signature`, `result` |
| ~~`authorization_documents`~~ | Digabung ke tabel `authorizations` (ADR-010): tipe, referensi, hash file, lokasi file terenkripsi |
| `destinations` | Whitelist wallet tujuan: address, network, label, `approved_by`, `approved_at` |
| `approvals` | Persetujuan transaksi/destinasi: `requested_by`, `approved_by`, keputusan, alasan |
| `scan_results` | Snapshot hasil per address per scan (histori), bukan hanya overwrite di `addresses` |
| `price_snapshots` | Harga per aset per waktu beserta sumbernya |

Tabel **di database vault terpisah** (`da_vault`, hanya diakses service `signer/`, lihat ADR-008):

| Tabel vault | Fungsi |
|-------------|--------|
| `vault_config` | `wrapped_mk` (oleh passphrase utama), `wrapped_mk_recovery`, salt & parameter Argon2id |
| `vault_keys` | `address`, `network`, `ciphertext`, `iv`, `auth_tag`, `key_type` (privkey/seed+path), `created_at` |
| `vault_events` | Log internal signer (unlock, lock, sign, reveal), tanpa isi key |

Revisi pada tabel yang sudah ada:
- `addresses`: hapus `balance_native` dan `estimated_value` (duplikat dengan `balances`), lalu tambah kolom status dari 2.2 dan `owner_reference` **NOT NULL**.
- `balances.quantity`, `transactions.amount`, `transactions.network_fee`: simpan sebagai `NUMERIC(78,0)` dalam base unit (wei/satoshi).
- `transactions`: tambah `created_by`, `unsigned_payload`, `unsigned_hash`, `signed_payload`, `nonce`, `confirmations`, `failure_reason`.
- `audit_logs`: tambah `request_id`, `user_agent`, `metadata` (JSON, sudah disensor), `prev_hash` (opsional, untuk hash chain anti-manipulasi). Tabel ini insert-only, tanpa UPDATE/DELETE.

### 2.4 Challenge signature rawan replay

**Masalah.** SA 4.5 tidak mengatur isi challenge.

**Revisi.** Pesan challenge wajib memuat:

```text
Digital Archaeology — Ownership Verification
Address: 0x...
Network: sepolia (chainId 11155111)
Purpose: Verify ownership for recovery case #<id>
Nonce: <random 32 byte hex>
Issued At: 2026-10-01T10:00:00Z
Expires At: 2026-10-01T10:15:00Z
```

Aturannya: nonce acak, hanya bisa dipakai sekali (`used_at`), kedaluwarsa singkat (misalnya 15 menit), dan terikat ke address, chain, serta kasus tertentu. Verifikasi untuk EVM memakai `verifyMessage` (EIP-191). Untuk Bitcoin nantinya memakai BIP-322.

### 2.5 Siapa yang memegang private key? — **Diputuskan: SUPER_ADMIN** (ADR-003)

| Opsi | Cara kerja | Risiko | Status |
|------|-----------|--------|--------|
| A. External signing | Server membuat tx unsigned, signer menandatangani di wallet sendiri | Paling rendah | Tidak dipilih |
| B. KMS/HSM | Key di AWS KMS (`ECC_SECG_P256K1`) atau HSM | Sedang | Kandidat upgrade pasca-MVP |
| **C. Key Vault terenkripsi, dipegang SUPER_ADMIN** | Key dienkripsi dengan kunci turunan passphrase super admin dan didekripsi di memori hanya saat signing | Sedang–tinggi, sehingga wajib memakai mitigasi di bawah | ✅ **Dipilih** |

Karena server sekarang memegang key, mitigasi berikut **wajib** dan tidak bisa ditawar:

| Mitigasi | Detail |
|----------|--------|
| Isolasi | Service `signer/` terpisah dengan DB sendiri (`da_vault`), tidak terekspos ke internet (ADR-008) |
| Enkripsi | Envelope encryption: Argon2id(passphrase) → KEK → Master Key → AES-256-GCM per key |
| Passphrase tidak disimpan | Tanpa passphrase super admin, dump DB vault tidak bisa dibuka |
| Unlock berbatas waktu | Master key ada di memori maksimal 10 menit, lalu vault terkunci otomatis |
| MFA wajib | SUPER_ADMIN wajib TOTP sejak Fase 3 (bukan opsional) |
| Signing hanya untuk tx `APPROVED` | Payload diambil dari data yang di-approve oleh REVIEWER ≠ pembuat |
| Kecocokan key ↔ address | Import ditolak jika address turunan key tidak ada di inventory beserta `owner_reference` |
| Reveal break-glass | Re-auth + MFA + passphrase, tampil 60 detik, rate limit, audit log tanpa isi key (ADR-009) |
| Recovery passphrase offline | Salinan kedua pembungkus master key, disimpan fisik (mitigasi passphrase hilang) |
| Redaction & test | Test otomatis memastikan key tidak muncul di log, DB aplikasi, response API (kecuali endpoint reveal), maupun error message |

Alur signing:

```text
REVIEWER approve tx
        │
        ▼
SUPER_ADMIN unlock vault (passphrase + MFA)
        │
        ▼
backend ──(internal, transaction_id)──► signer service
                                            │ ambil payload APPROVED, verifikasi ulang
                                            │ dekripsi key di memori → sign → buang key
                                            ▼
backend ◄──────────── signed tx ────────────┘
        │
        ▼
broadcast → confirm → audit
```

Bonus: karena key ada di vault, **verifikasi kepemilikan (Fase 7)** bisa dilakukan oleh signer dengan menandatangani challenge memakai key yang tersimpan. Ini membuktikan bahwa key yang dipegang memang cocok dengan address-nya. Dokumen otorisasi/mandat tetap wajib sebagai dasar hukum.

### 2.6 Eligibility untuk token butuh gas native

**Masalah.** Address yang hanya berisi token ERC-20 (tanpa ETH) tidak bisa mengirim token karena butuh gas. Rumus `net_value = estimated_value - estimated_fee` di SA belum memperhitungkan hal ini.

**Revisi.** Tambahkan aturan:

```text
if asset is token and native_balance < estimated_fee:
    recovery_status = NOT_ELIGIBLE
    reason = "NEEDS_GAS_FUNDING"   # perlu keputusan manual untuk top-up gas
```

Selain itu:
- Untuk transfer native, jumlah yang dikirim adalah `balance - fee` (sweep). Hitungannya harus memakai base unit.
- Fee dihitung ulang tepat sebelum preview, karena estimasi lama bisa basi.
- Tambahkan margin keamanan fee (misalnya +20%) yang bisa dikonfigurasi.

Satu syarat lagi karena signing lewat vault: jika key address belum di-import ke vault, statusnya `NOT_ELIGIBLE` dengan reason `NO_KEY_IN_VAULT`.

### 2.7 Approval: aturan maker-checker

- User yang membuat transaksi **tidak boleh** meng-approve transaksi yang sama.
- Destination baru wajib di-approve sebelum bisa dipakai.
- Approval kedaluwarsa jika fee/saldo berubah melebihi toleransi, sehingga harus dibuat preview ulang.
- Semua keputusan approval/reject wajib menyertakan alasan dan tercatat di audit log.

---

## 3. Perbedaan EVM dan Bitcoin (untuk perencanaan adapter)

| Aspek | EVM (Ethereum, dan lain-lain) | Bitcoin |
|-------|-------------------------------|---------|
| Model saldo | Account (saldo per address) | UTXO (kumpulan output) |
| Replay protection tx | Nonce + chainId | UTXO hanya bisa dipakai sekali |
| Fee | gas × (base fee + priority fee) | sat/vByte × ukuran tx |
| Token | ERC-20 (perlu gas native) | Tidak ada (kecuali protokol tambahan) |
| Sign message | EIP-191 / EIP-712 | BIP-137 (legacy) / BIP-322 |
| Format tx unsigned | Objek tx / serialized | PSBT |
| Jenis address | Satu format (0x…) | P2PKH, P2SH, P2WPKH, P2TR |

Karena itu interface `ChainAdapter` minimal punya method berikut:

```ts
interface ChainAdapter {
  validateAddress(address: string): boolean
  getNativeBalance(address: string): Promise<bigint>
  getTokenBalance(address: string, token: AssetConfig): Promise<bigint>
  getActivity(address: string): Promise<ActivitySummary>
  estimateTransferFee(params: TransferParams): Promise<FeeEstimate>
  buildUnsignedTransfer(params: TransferParams): Promise<UnsignedTx>
  verifySignedTx(signed: string, expected: UnsignedTx): Promise<VerifyResult>
  verifyMessage(address: string, message: string, signature: string): Promise<boolean>
  broadcast(signed: string): Promise<string /* txHash */>
  getConfirmations(txHash: string): Promise<number>
}
```

---

## 4. Daftar risiko

| # | Risiko | Dampak | Kemungkinan | Mitigasi |
|---|--------|--------|-------------|----------|
| R1 | Kebocoran private key dari server/vault | Kritis | Sedang | Service signer terisolasi, envelope encryption, passphrase tidak disimpan, unlock berbatas waktu, test redaction |
| R2 | Salah address tujuan | Kritis | Sedang | Whitelist, approval, preview ulang, checksum address, test transfer kecil |
| R3 | Sistem dipakai untuk aset yang bukan miliknya | Kritis (hukum) | Sedang | `owner_reference` wajib, dokumen otorisasi, signature proof, audit log |
| R4 | Fee lebih besar dari saldo | Sedang | Tinggi | Eligibility engine, re-estimate fee sebelum signing |
| R5 | Rate limit / downtime RPC & explorer | Sedang | Tinggi | Retry + backoff, cache, provider cadangan, status `REQUIRES_REVIEW` |
| R6 | Data aktivitas salah (indexer tidak lengkap) | Sedang | Sedang | Silang cek nonce RPC vs indexer, flag review jika berbeda |
| R7 | Tx stuck / gagal | Sedang | Sedang | Tracking konfirmasi, status `FAILED`, prosedur speed-up/cancel manual |
| R8 | Pembulatan jumlah (float) | Tinggi | Sedang tanpa aturan | `bigint` + NUMERIC, larangan float di lint/review |
| R9 | Akun operator dibajak | Kritis | Rendah–Sedang | MFA, session timeout, rate limit, maker-checker |
| R10 | Dokumen otorisasi (PII) bocor | Tinggi | Rendah | Simpan terenkripsi, akses berbasis role, retensi data |
| R11 | Super admin lupa passphrase / tidak tersedia | Kritis (semua key tak bisa dibuka) | Rendah–Sedang | Recovery passphrase offline di brankas, prosedur di runbook, uji pemulihan berkala |
| R12 | Penyalahgunaan oleh pemegang akses super admin | Kritis | Rendah | Signing hanya untuk tx APPROVED oleh orang lain, audit log append-only, reveal tercatat + rate limit, review audit berkala oleh AUDITOR |
| R13 | Akun super admin dibajak | Kritis | Rendah–Sedang | MFA wajib, re-auth untuk aksi vault, passphrase terpisah dari password login, notifikasi setiap unlock/reveal |
| R14 | Key tampil di layar saat reveal (screenshot, malware) | Tinggi | Sedang | Reveal dibatasi 60 detik, tersamar default, bisa dimatikan via `KEY_REVEAL_ENABLED=false` |

---

## 5. Pertanyaan terbuka (jawab sebelum fase terkait)

| # | Pertanyaan | Dibutuhkan sebelum |
|---|-----------|--------------------|
| Q1 | Mayoritas wallet lama yang akan diproses ada di chain apa? Jika mayoritas Bitcoin, pertimbangkan BTC sebagai chain pertama | Fase 5 |
| Q2 | Dipakai sendiri atau melayani klien? Jika klien: format mandat apa yang diterima? | Fase 7 |
| Q3 | Provider RPC & explorer mana (Alchemy, Infura, Etherscan, self-hosted)? | Fase 5 |
| Q4 | Provider harga (CoinGecko, CoinMarketCap)? Mata uang referensi (USD/IDR)? | Fase 6 |
| Q5 | Deploy di mana (VPS, cloud, on-prem)? | Fase 14 |
| Q6 | Berapa user/operator yang akan memakai? (menentukan apakah MFA wajib dari awal) | Fase 3 |

Catat jawabannya di [07-decisions.md](07-decisions.md).
