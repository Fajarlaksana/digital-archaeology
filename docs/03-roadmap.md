# 03 — Roadmap Step-by-Step

Aturan pakai:
- Kerjakan **berurutan**. Jangan lanjut ke fase berikutnya sebelum *Definition of Done* (DoD) fase sekarang terpenuhi.
- Setiap fase punya prompt pasangan di [04-prompting.md](04-prompting.md) dengan nomor yang sama.
- Centang `[x]` saat sebuah tugas selesai, lalu commit.
- Ukuran: **S** = 1 sesi, **M** = 2–3 sesi, **L** = 4+ sesi.

```text
M1 Watch-only     : F0 → F1 → F2 → F3 → F4 → F5 → F6
M2 Proof          : F7 → F8
M3 Recovery       : F9 → F10 → F11
M4 Production     : F12 → F13 → F14
```

---

## Fase 0 — Persiapan & Keputusan · S

**Tujuan:** semua keputusan dasar sudah diambil sebelum menulis kode.

- [x] Baca [01-project-direction.md](01-project-direction.md) dan [02-project-analysis.md](02-project-analysis.md)
- [x] Tetapkan ADR-001 (stack), ADR-002 (chain pertama), ADR-003 (model signing) di [07-decisions.md](07-decisions.md)
- [x] Jawab pertanyaan Q1–Q6 sebisanya (Q1, Q2, Q6 terjawab; Q3–Q5 menyusul)
- [ ] Install tools: Git, Node.js LTS, pnpm, Docker Desktop (lihat [05-development-guide.md](05-development-guide.md))
- [ ] Buat akun RPC provider (Alchemy/Infura) dan explorer API key (Etherscan) untuk **Sepolia**
- [ ] Siapkan 2–3 wallet **testnet** milik sendiri dan isi dengan ETH Sepolia dari faucet
- [ ] `git init`, lalu commit dokumen

**DoD:** ADR-001/002/003 berstatus *Accepted*, tools terpasang, dan wallet testnet sudah ada saldonya.

---

## Fase 1 — Fondasi Repository · M

**Tujuan:** kerangka monorepo yang bisa jalan, dites, dan di-lint.

- [x] pnpm workspace: `backend/`, `frontend/`, `shared/` (`@da/shared`: logger + error)
- [x] `docker-compose.yml`: PostgreSQL 16 (2 database: `digital_archaeology` dan `da_vault`, dengan user DB berbeda) + Redis
- [x] Backend Fastify + TypeScript strict + konfigurasi env tervalidasi Zod (`src/config`)
- [x] Logger Pino dengan daftar `redact` untuk field sensitif
- [x] Endpoint `GET /health`, `/health/database`, `/health/rpc` (stub dulu)
- [x] Format error standar (`code, message, timestamp, request_id, resource_id`)
- [x] Frontend React + Vite + Tailwind dengan layout & menu kosong (sesuai SA bagian 14)
- [x] ESLint + Prettier + Vitest di kedua package
- [x] `.env.example`, `.gitignore` (wajib berisi `.env`, `*.key`, `*.pem`, `keystore/`)
- [x] Isi bagian **Perintah** di [CLAUDE.md](../CLAUDE.md)

**DoD:** `docker compose up -d && pnpm dev` jalan, `/health` mengembalikan 200, `pnpm test`, `pnpm lint`, dan `pnpm typecheck` hijau, dan test redaction logger lulus.

> **Status 2026-10-01:** semua terpenuhi **kecuali** verifikasi `docker compose up -d`, karena Docker Desktop di mesin dev gagal start ("Docker Desktop is unable to start"). Tanpa DB, `/health/database` sudah terbukti mengembalikan 503 `DATABASE_UNAVAILABLE`. Setelah Docker hidup: jalankan `docker compose up -d`, lalu pastikan `/health/database` = 200.

---

## Fase 2 — Database & Domain Model · M

**Tujuan:** skema DB final versi MVP (SA bagian 5 + revisi di 02-analysis bagian 2.2–2.3).

- [x] Prisma schema (15 tabel): `networks, assets, price_snapshots, addresses, balances, scans, scan_results, users, user_roles, authorizations, ownership_challenges, destinations, approvals, transactions, audit_logs`. Tabel `authorizations` (SA 5.5) sekaligus menyimpan metadata dokumen otorisasi, menggantikan rencana tabel `authorization_documents`
- [x] Tabel vault **tidak** ada di schema ini (milik `signer/`, Fase 7), dan schema aplikasi tidak punya kolom key/seed/passphrase
- [x] Kolom jumlah memakai `Decimal @db.Decimal(78,0)` (base unit)
- [x] Status dipecah per dimensi (enum Prisma)
- [x] `addresses.owner_reference` NOT NULL + CHECK tidak kosong, unique `(network_id, address)`
- [x] Constraint DB tambahan: jumlah ≥ 0, satu aset native per network, approval `decided_by ≠ requested_by`, subject approval konsisten
- [x] Migrasi awal (`20261002000000_init`) + seed: network Sepolia, ETH, USDC & LINK testnet
- [ ] ~~User admin dev di seed~~ → dipindah ke Fase 3 (butuh argon2; SUPER_ADMIN hanya via CLI)
- [x] Helper `toBaseUnit` / `fromBaseUnit` / `parseBaseUnits` (bigint) + jembatan `toDbAmount`/`fromDbAmount` + unit test
- [x] Repository: audit-log, network, address (+ balance). Repository entitas lain dibuat di fase yang memakainya
- [x] Audit log insert-only: repository tanpa update/delete **dan** trigger DB yang menolak UPDATE/DELETE/TRUNCATE; metadata otomatis di-redact
- [ ] **Terapkan migrasi + seed ke database & jalankan test DB** (menunggu `scripts/db/native-setup.sql` dijalankan)

**DoD:** migrasi bersih dari nol, seed jalan, unit test konversi jumlah lulus (termasuk edge case 18 desimal).

---

## Fase 3 — Autentikasi & RBAC · M

- [ ] Register user oleh ADMIN (tidak ada self-register), login, logout
- [ ] Password hashing (argon2), session/JWT di httpOnly cookie, session timeout
- [ ] Rate limit pada endpoint login
- [ ] Role: `SUPER_ADMIN, ADMIN, ANALYST, REVIEWER, AUDITOR` dengan permission sesuai SA 8.2 + ADR-003
- [ ] Seed user dev (ADMIN/ANALYST/REVIEWER/AUDITOR, password dari env), dipindahkan dari Fase 2
- [ ] SUPER_ADMIN hanya bisa dibuat lewat CLI/seed di server (`pnpm --filter backend create-super-admin`), tidak bisa lewat UI
- [ ] Middleware `requirePermission()` + `requireRecentAuth()` (re-auth untuk aksi sensitif)
- [ ] **MFA TOTP wajib** untuk SUPER_ADMIN & REVIEWER (login ditolak jika MFA belum disetel)
- [ ] Audit log otomatis untuk login sukses/gagal dan setiap request yang mengubah data
- [ ] Halaman login, setup MFA, dan manajemen user di frontend

**DoD:** test integrasi membuktikan setiap role hanya bisa mengakses endpoint yang diizinkan, ADMIN biasa tidak bisa mengakses endpoint vault, dan password tidak pernah muncul di log.

---

## Fase 4 — Network & Address Inventory · M

- [ ] CRUD `networks` (ADMIN) dan `assets`
- [ ] Tambah address manual dengan validasi format dan checksum per chain, `owner_reference` wajib
- [ ] Import CSV (`address, network, label, owner_reference`) dengan laporan baris yang ditolak
- [ ] Halaman Networks, Addresses (tabel + filter), dan Address Detail (kerangka)
- [ ] Audit log untuk tambah/ubah/hapus address

**DoD:** import CSV 100 baris campuran valid/invalid menghasilkan laporan yang benar, dan address tanpa `owner_reference` ditolak.

---

## Fase 5 — Scanner & Activity Analyzer · L

**Tujuan:** inti M1, membaca data blockchain secara andal.

- [ ] Interface `ChainAdapter` (lihat 02-analysis bagian 3), `BalanceProvider`, `ActivityProvider`
- [ ] Implementasi EVM dengan viem: saldo native, saldo ERC-20, nonce
- [ ] Activity provider via explorer API: `last_incoming_at`, `last_outgoing_at`, jumlah tx masuk/keluar
- [ ] Silang cek: jika nonce RPC ≠ jumlah tx keluar menurut indexer, beri `review_flag`
- [ ] Analyzer: `inactive_days`, `activity_status` berdasarkan threshold konfigurasi
- [ ] Job BullMQ `SCAN_AUTHORIZED_ADDRESSES` dengan retry + exponential backoff, rate limit per provider
- [ ] Simpan `scans` + `scan_results` (histori) dan update status di `addresses`
- [ ] `POST /api/scans`, `GET /api/scans`, `GET /api/addresses/:id/activity`
- [ ] Halaman Scans (buat scan, progres, hasil)
- [ ] Unit test analyzer dengan mock adapter, dan integration test terhadap Sepolia (dipisah, opsional di CI)

**DoD:** scan atas wallet testnet milik sendiri menghasilkan saldo dan tanggal aktivitas yang **cocok dengan explorer**, scan ulang menghasilkan data identik, dan error RPC tercatat tanpa membuat seluruh scan crash.

---

## Fase 6 — Valuasi & Dashboard Read-only · M

- [ ] `PriceProvider` (misalnya CoinGecko) + cache + simpan ke `price_snapshots`
- [ ] Hitung `fiat_value` dengan decimal library (tidak memakai float)
- [ ] Job `UPDATE_PRICE`, `REFRESH_BALANCES`, dan scheduler (daily/weekly/manual)
- [ ] Dashboard cards (SA bagian 14) + riwayat aktivitas + status job
- [ ] Address Detail lengkap: saldo per aset, aktivitas, histori scan
- [ ] Export CSV inventory & inactivity report

**DoD — Milestone M1 tercapai:** semua wallet testnet tampil di dashboard dengan saldo, nilai fiat (beserta timestamp harga), dan status aktivitas yang benar. Tag git `v0.1.0-m1`.

---

## Fase 7 — Key Vault & Ownership Verification · L

**Tujuan:** service `signer/` berdiri, key bisa disimpan aman, dan kepemilikan terbukti. Fase ini dikerjakan lebih awal dari signing transaksi karena verifikasi kepemilikan sudah butuh vault.

**7a — Key Vault (service `signer/`)**
- [ ] Package `signer/`: Fastify internal, listen hanya di jaringan internal, autentikasi backend↔signer (shared secret HMAC atau mTLS)
- [ ] DB `da_vault` (Prisma schema terpisah): `vault_config`, `vault_keys`, `vault_events`
- [ ] Inisialisasi vault: SUPER_ADMIN menetapkan passphrase utama + recovery passphrase, lalu generate Master Key, lalu wrap dua kali (Argon2id + AES-256-GCM)
- [ ] Unlock/lock: unlock dengan passphrase + MFA, auto-lock setelah `VAULT_UNLOCK_TTL_MINUTES`, lock saat logout/restart
- [ ] Import key (hex privkey atau seed + derivation path): derive address, cocokkan dengan inventory (`owner_reference` wajib), lalu enkripsi dan simpan. Jika tidak cocok, tolak
- [ ] Ganti passphrase (rewrap MK) dan pemulihan dengan recovery passphrase
- [ ] Reveal break-glass sesuai ADR-009 (flag `KEY_REVEAL_ENABLED`)
- [ ] Halaman **Key Vault** (hanya SUPER_ADMIN): status lock, daftar address yang punya key (tanpa isi key), import, unlock, reveal

**7b — Ownership Verification**
- [ ] Upload/registrasi dokumen otorisasi (simpan hash + file terenkripsi, atau hanya referensi eksternal)
- [ ] Generate challenge (format di 02-analysis bagian 2.4), dengan nonce single-use dan expiry
- [ ] Verifikasi untuk address yang key-nya ada di vault: signer menandatangani challenge (vault harus unlocked)
- [ ] Verifikasi untuk address yang key-nya tidak di vault: connect wallet (`personal_sign`) atau paste signature
- [ ] Verifikasi signature di server (`verifyMessage`), lalu update `authorization_status`
- [ ] Tolak challenge yang kedaluwarsa atau sudah dipakai (test replay)
- [ ] Audit log setiap langkah

**DoD:**
- Signature valid menghasilkan `VERIFIED`, sedangkan signature dari address lain, challenge kedaluwarsa, dan replay semuanya ditolak (ada test untuk masing-masing).
- Test: dump `da_vault` + semua env server **tanpa passphrase** tidak bisa mendekripsi key.
- Test: key salah address ditolak saat import; vault terkunci otomatis setelah TTL; role selain SUPER_ADMIN mendapat 403 di semua endpoint vault.
- Test: grep log backend + signer setelah import/sign/reveal tidak menemukan key.

---

## Fase 8 — Destination Whitelist & Eligibility Engine · M

- [ ] CRUD `destinations` + approval oleh REVIEWER (bukan pembuatnya)
- [ ] Fee estimator (EIP-1559) + margin konfigurasi
- [ ] Eligibility engine sesuai SA 4.7 + revisi 02-analysis bagian 2.6 (`NEEDS_GAS_FUNDING`) + cek key tersedia di vault (`NO_KEY_IN_VAULT`)
- [ ] Field `recovery_status` + alasan, terlihat di UI
- [ ] Eligibility report (CSV)
- [ ] Unit test semua cabang aturan eligibility

**DoD — Milestone M2 tercapai:** daftar address `READY` akurat, dan setiap address `NOT_*` punya alasan yang jelas. Tag `v0.2.0-m2`.

---

## Fase 9 — Transaction Preview & Approval · M

- [ ] `POST /api/transactions/preview`: bangun tx unsigned (from, to, value sweep, nonce, chainId, fee cap)
- [ ] Simpan `unsigned_payload` + `unsigned_hash`, status `CREATED`
- [ ] Halaman Recovery: tampilkan ulang Source/Destination/Asset/Amount/Fee/Network (SA 4.8)
- [ ] Approval oleh REVIEWER ≠ pembuat, wajib dengan alasan, status `APPROVED`
- [ ] Approval otomatis kedaluwarsa jika fee/saldo berubah di luar toleransi

**DoD:** test membuktikan pembuat tidak bisa meng-approve tx miliknya sendiri, dan preview selalu memakai fee terbaru.

---

## Fase 10 — Transaction Signing via Key Vault · M

- [ ] Halaman **Signing** (hanya SUPER_ADMIN): daftar tx `APPROVED`, detail ulang, lalu tombol **Sign** (wajib vault unlocked + re-auth MFA jika sesi lebih dari 5 menit)
- [ ] `POST /api/transactions/:id/sign`: backend hanya mengirim `transaction_id` ke signer, bukan payload dari client
- [ ] Signer: ambil payload yang di-approve dari backend/DB, cek status `APPROVED` + approver ≠ pembuat, dekripsi key di memori, sign, lalu buang key. Yang dikembalikan hanya signed raw tx
- [ ] Signed Tx Verifier di backend: decode signed tx, lalu cocokkan dengan payload yang di-approve (from/to/value/data/nonce/chainId/fee cap). Lapisan kedua ini menjaga kalau signer bermasalah
- [ ] Status `SIGNED` + audit log (`TX_SIGNED`, tanpa isi key)
- [ ] (Opsional) Alur offline untuk address yang key-nya tidak di vault: export unsigned, lalu import signed raw tx

**DoD:** test membuktikan signer menolak tx yang belum `APPROVED` atau di-approve oleh pembuatnya sendiri, signed tx yang tidak cocok dengan payload ditolak, dan network tab browser tidak memuat key saat signing.

---

## Fase 11 — Broadcast & Confirmation · M

- [ ] `POST /api/transactions/broadcast`, lalu simpan `tx_hash` dengan status `BROADCASTED`/`PENDING`
- [ ] Job `CHECK_PENDING_TRANSACTIONS`: update konfirmasi, lalu `CONFIRMED`/`FAILED`
- [ ] Update `recovery_status = TRANSFERRED` dan refresh saldo
- [ ] Halaman Transactions + link ke explorer
- [ ] **Uji end-to-end di Sepolia:** import address → scan → import key ke vault → verify → whitelist → eligibility → preview → approve → unlock vault & sign → broadcast → confirmed

**DoD — Milestone M3 tercapai:** minimal 3 recovery end-to-end sukses di testnet dengan audit trail lengkap. Tag `v0.3.0-m3`.

---

## Fase 12 — Reporting & Audit UI · S–M

- [ ] Semua laporan SA bagian 21 (CSV, PDF opsional) dengan pemisahan data publik / estimasi / otorisasi / status (SA bagian 13)
- [ ] Halaman Audit Logs (read-only, filter) untuk AUDITOR
- [ ] (Opsional) verifikasi hash chain audit log

---

## Fase 13 — Hardening Keamanan & Monitoring · M

- [ ] Security test (SA bagian 17): authN, authZ, rate limit, input validation, replay, approval flow
- [ ] Test "no secret leakage": grep log + response API + DB dump untuk pola key/seed (kecuali endpoint reveal)
- [ ] Pastikan service `signer/` tidak bisa diakses dari luar jaringan internal (port scan)
- [ ] Notifikasi (email/Telegram) setiap vault unlock, reveal, dan signing
- [ ] Review audit log aksi SUPER_ADMIN oleh AUDITOR (prosedur berkala)
- [ ] Metrics (SA bagian 10) + health check lengkap
- [ ] Dependency audit (`pnpm audit`), header keamanan (helmet), CORS ketat
- [ ] Jalankan `/security-review` di Claude Code dan tindaklanjuti temuannya

---

## Fase 14 — Deploy & Operasional · M

- [ ] Dockerfile produksi + compose/infra target
- [ ] Secret dari secret manager/env server (bukan file di repo)
- [ ] Backup DB terjadwal (aplikasi + `da_vault`) + uji restore
- [ ] **Uji pemulihan vault**: restore `da_vault` di mesin bersih, lalu buka dengan recovery passphrase, lalu sign tx testnet
- [ ] Prosedur penyimpanan recovery passphrase (offline, fisik) tertulis di runbook
- [ ] Runbook operasional (tambahkan ke [06-manual-guide.md](06-manual-guide.md))
- [ ] Aktifkan mainnet lewat konfigurasi eksplisit. **Transfer pertama di mainnet dimulai dengan jumlah kecil**

**DoD — Milestone M4 tercapai:** tag `v1.0.0`.

---

## Log progres

| Tanggal | Fase | Catatan |
|---------|------|---------|
| 2026-10-01 | F0 | Dokumen perencanaan dibuat |
| 2026-10-01 | F0 | ADR-003/008/009: key dipegang SUPER_ADMIN di Key Vault terenkripsi |
| 2026-10-01 | F0 | ADR-001/002/004–007 Accepted: TypeScript stack, EVM Sepolia, internal use, >3 operator |
| 2026-10-01 | F1 | Monorepo + shared/backend/frontend, 49 test hijau. Pending: verifikasi Docker (Docker Desktop gagal start) |
| 2026-10-02 | F2 | Schema + migrasi + seed + repository, 107 test hijau (12 test DB di-skip). Dev DB: PostgreSQL 16 native di port 5433 (pengganti Docker) |
