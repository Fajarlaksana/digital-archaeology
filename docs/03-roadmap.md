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

> **Update 2026-10-02 (2):** Docker Desktop berjalan dengan backend Hyper-V. `docker compose up -d` terverifikasi: kedua container sehat, script init membuat 2 DB + 2 user, isolasi vault berlaku, migrasi + 80 test lulus. **DoD Fase 1 terpenuhi penuh.**
>
> **Update 2026-10-02:** `/health/database` = 200 terhadap PostgreSQL 16 native (ADR-011).
>
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
- [x] Migrasi + seed diterapkan ke PostgreSQL 16 native (seed idempoten), 12 test DB lulus, `/health/database` = 200

**DoD:** migrasi bersih dari nol, seed jalan, unit test konversi jumlah lulus (termasuk edge case 18 desimal).

---

## Fase 3 — Autentikasi & RBAC · M

- [x] User dibuat oleh ADMIN (tidak ada self-register), login, logout
- [x] Password argon2id; **session di database** (cookie `httpOnly`, `SameSite=Strict`, hanya hash token yang disimpan), idle timeout 30 menit + maksimum 12 jam
- [x] Rate limit login (5 per 15 menit per IP+email, 50 per IP) + akun terkunci setelah 10 kegagalan; pesan error selalu generik
- [x] Role `SUPER_ADMIN, ADMIN, ANALYST, REVIEWER, AUDITOR`; peta permission terpusat (`backend/src/auth/permissions.ts`, kosakata di `@da/shared/rbac`)
- [x] Seed user dev (ADMIN/ANALYST/REVIEWER/AUDITOR, password dari `SEED_DEV_PASSWORD`)
- [x] SUPER_ADMIN hanya lewat CLI server: `pnpm --filter backend user:create --role SUPER_ADMIN ...` (API menolak memberi, mencabut, maupun mengubah SUPER_ADMIN)
- [x] Guard `permission()`, `session()`, `recentAuth()` + endpoint `/api/auth/reauth`
- [x] **MFA TOTP wajib** untuk SUPER_ADMIN, ADMIN, REVIEWER (ADR-012); secret terenkripsi AES-256-GCM; anti-replay; session dicabut setelah 5 kode salah
- [x] Audit otomatis: login sukses/gagal, akun terkunci, MFA, akses ditolak, perubahan user (before/after), dan setiap request POST/PATCH/DELETE (tanpa body)
- [x] CSRF: tolak `Origin` asing untuk request yang mengubah data, parser `text/plain` dihapus
- [x] Frontend: login, verifikasi & setup MFA (QR), menu sesuai permission, halaman Users
- [ ] Reset MFA untuk user yang kehilangan perangkat → dipindah ke Fase 13 (butuh prosedur verifikasi identitas)

**DoD:** test integrasi membuktikan setiap role hanya bisa mengakses endpoint yang diizinkan, ADMIN biasa tidak bisa mengakses endpoint vault, dan password tidak pernah muncul di log.

> **Status 2026-10-02:** terpenuhi. 187 test hijau, termasuk matriks role × endpoint, MFA, replay TOTP, rate limit, penguncian akun, kedaluwarsa session, dan CSRF. Uji langsung lewat proxy Vite juga lulus. (Endpoint vault belum ada; permission `vault:manage` hanya dimiliki SUPER_ADMIN dan dikunci oleh unit test.)

---

## Fase 4 — Network & Address Inventory · M

- [x] Networks (ADMIN): list, tambah (beserta aset native), ubah, nonaktifkan; token ERC-20 dengan validasi kontrak. Network mainnet ditolak selama `NETWORK_MODE=testnet`; `isTestnet`/`chainId` tidak bisa diubah
- [x] `ChainAdapter` + implementasi EVM (viem): validasi format, checksum EIP-55 (salah checksum = ditolak), zero address ditolak, disimpan dalam bentuk checksum
- [x] Tambah address manual (ANALYST), `owner_reference` wajib (validasi API + CHECK DB)
- [x] Ubah label/owner reference (audit before/after), **arsip & pulihkan** (bukan hapus; histori tetap utuh)
- [x] Import CSV dengan **preview dulu** → simpan baris valid; validasi ulang di server saat simpan; maks. 5.000 baris / 2 MB; laporan per baris + ringkasan per alasan
- [x] Halaman Networks, Addresses (filter network/arsip, pencarian, pagination, form tambah, panel import), Address Detail
- [x] Audit: `NETWORK_CREATED/UPDATED`, `ASSET_CREATED`, `ADDRESS_CREATED/UPDATED/ARCHIVED/RESTORED`, `ADDRESSES_IMPORTED` (SHA-256 file)

**DoD:** import CSV 100 baris campuran valid/invalid menghasilkan laporan yang benar, dan address tanpa `owner_reference` ditolak.

> **Status 2026-10-02:** terpenuhi. Test import 100 baris (70 valid; 10 checksum salah, 5 network tak dikenal, 5 tanpa owner ref, 5 duplikat di file, 5 sudah terdaftar) menghasilkan laporan tepat; preview tidak menyimpan apa pun; import ulang tidak membuat duplikat. 257 test hijau.

---

## Fase 5 — Scanner & Activity Analyzer · L

**Tujuan:** inti M1, membaca data blockchain secara andal.

- [x] Interface `ChainAdapter` (validasi), `ChainReader` (RPC), `ActivityProvider` (explorer) di `backend/src/chains`
- [x] `ChainReader` EVM dengan viem: saldo native, saldo ERC-20 (`balanceOf`), nonce, chain id, block; error dipetakan ke `RPC_TIMEOUT` / `RPC_RATE_LIMIT` / `BALANCE_READ_FAILED` tanpa URL
- [x] Activity provider Etherscan API v2: tx normal + internal + transfer token; `first/last_incoming/last_outgoing`, jumlah tx masuk/keluar; pagination s.d. 10.000/aksi (lebih dari itu → `HISTORY_TRUNCATED`); throttle + retry backoff
- [x] Silang cek nonce RPC vs jumlah tx keluar → `review_flag` + `review_note` (`NONCE_MISMATCH`, `HISTORY_TRUNCATED`, `BALANCE_WITHOUT_HISTORY`)
- [x] Analyzer (pure): basis **transaksi keluar** (ADR-015), `inactive_days`, `activity_status`, `balance_status`
- [x] Job BullMQ (`scans`, concurrency 1, jobId = scanId); proses idempoten, bisa dilanjutkan setelah crash; error per address tidak menghentikan scan; scan tidak pernah macet `RUNNING`
- [x] `scans` + `scan_results` (histori) + update `addresses` dan `balances` dalam satu transaksi per address; address arsip tidak di-scan
- [x] Endpoint `POST/GET /api/scans`, `GET /api/scans/:id`, `/results?filter=all|inactive|criteria|review|failed`, `GET /api/addresses/:id/activity`, `/balances`; `/health/rpc` memeriksa chain id + block
- [x] Halaman Scans (form, progres dengan polling, daftar) + detail scan (tab filter) + saldo & riwayat di detail address
- [x] Unit test analyzer/provider/reader dengan data tiruan; integration test end-to-end dengan chain tiruan; test Sepolia live (`tests/integration/chain/sepolia.live.test.ts`, otomatis skip tanpa key)
- [ ] **Verifikasi live** dengan wallet testnet sendiri (butuh `SEPOLIA_RPC_URL` + `EXPLORER_API_KEY` di `.env`)

**DoD:** scan atas wallet testnet milik sendiri menghasilkan saldo dan tanggal aktivitas yang **cocok dengan explorer**, scan ulang menghasilkan data identik, dan error RPC tercatat tanpa membuat seluruh scan crash.

> **Status 2026-10-02:** kode selesai dan 305 test hijau. "Error RPC tidak membuat scan crash" sudah terbukti lewat test. **Belum terbukti:** kecocokan dengan explorer pada wallet sungguhan, karena key Sepolia belum diisi. Setelah key diisi: jalankan `pnpm --filter backend test` (3 test live ikut berjalan), lalu scan wallet testnet sendiri dan bandingkan saldo/tanggal dengan sepolia.etherscan.io.

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
- [ ] Reset MFA oleh ADMIN untuk user yang kehilangan perangkat (dengan verifikasi identitas + audit)
- [ ] Pindahkan rate limiter login ke Redis jika API dijalankan lebih dari satu instance

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
| 2026-10-02 | F1 | Docker Desktop (Hyper-V) hidup: `docker compose up -d` terverifikasi (port 5434), dev DB pindah ke Docker (ADR-013) |
| 2026-10-02 | F5 | Kode selesai: scanner RPC+Etherscan, analyzer basis transaksi keluar, BullMQ, UI scans; 305 test hijau. Tertunda: verifikasi live (key Sepolia) |
| 2026-10-02 | F4 | Selesai. Networks, ChainAdapter EVM, inventaris address, arsip, import CSV preview→simpan; 257 test hijau |
| 2026-10-02 | F3 | Selesai. Auth + RBAC + MFA + Users UI, 187 test hijau |
| 2026-10-02 | F2 | Selesai. Schema + migrasi + seed + repository; 119 test hijau termasuk 12 test DB (audit log append-only, constraint, uint256). Dev DB: PostgreSQL 16 native port 5433 |
