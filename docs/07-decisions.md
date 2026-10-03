# 07 — Catatan Keputusan (Architecture Decision Records)

Setiap keputusan penting dicatat di sini agar alasannya tidak hilang. Status yang dipakai: **Proposed** (usulan), **Accepted** (diterima), **Superseded** (diganti oleh ADR lain).

Ubah status dari *Proposed* ke *Accepted* setelah Anda setuju. ADR-001 s/d ADR-017 sudah diputuskan (ADR-011 digantikan ADR-013).

---

## ADR-001 — Stack teknologi
- **Status:** Accepted
- **Tanggal:** 2026-10-01
- **Keputusan:** TypeScript end-to-end. Backend Fastify + Prisma + PostgreSQL + Redis/BullMQ + Pino + Zod + Vitest. Frontend React + Vite + TanStack Query + Tailwind. Monorepo pnpm.
- **Alasan:** satu bahasa, ekosistem web3 (viem/wagmi) terbaik ada di TS, dan validasi + tipe membantu mencegah bug jumlah aset.
- **Alternatif:** NestJS (lebih terstruktur tetapi lebih berat), Laravel/PHP, Python FastAPI + web3.py.
- **Konsekuensi:** prompt di 04-prompting.md mengikuti stack ini. Jika stack diganti, prompt-nya juga perlu disesuaikan.

## ADR-002 — Chain pertama
- **Status:** Accepted
- **Tanggal:** 2026-10-01
- **Keputusan:** EVM, dimulai dari **Sepolia testnet**. Bitcoin menyusul setelah MVP lewat `ChainAdapter`.
- **Alasan:** tooling signing dan verifikasi pesan (EIP-191) paling matang, faucet mudah didapat, dan satu adapter langsung bisa dipakai untuk banyak chain EVM.
- **Kapan ditinjau ulang:** jika jawaban Q1 di 02-analysis adalah "mayoritas wallet di Bitcoin". Dalam kasus itu, pertimbangkan Bitcoin testnet/signet sebagai chain pertama (PSBT + BIP-322).

## ADR-003 — Model signing: key dipegang SUPER_ADMIN
- **Status:** Accepted
- **Tanggal:** 2026-10-01
- **Konteks:** sistem harus bisa menandatangani transaksi recovery. Pertanyaannya: siapa yang memegang private key?
- **Keputusan:** private key disimpan **terenkripsi di Key Vault server-side** dan hanya role **SUPER_ADMIN** yang bisa import, membuka (unlock), memakai untuk signing, dan melihat key. Detail teknisnya di ADR-008 dan ADR-009.
- **Alasan:** keputusan pemilik projek, agar kendali key terpusat pada satu pihak tepercaya dan proses signing tidak bergantung pada wallet eksternal masing-masing pemilik address.
- **Alternatif yang dipertimbangkan:**
  - *External signing* (key di wallet/hardware wallet signer, server tidak pernah memegang key). Risikonya paling rendah, tetapi tidak memberi kendali terpusat. Tidak dipilih.
  - *KMS/HSM* (AWS KMS `ECC_SECG_P256K1`). Bisa menjadi upgrade setelah MVP, sebagai ADR baru.
- **Konsekuensi:**
  - Risiko R1 (kebocoran key) naik dari *rendah* menjadi *sedang–tinggi*, sehingga isolasi vault, enkripsi, MFA, dan audit menjadi wajib sejak awal, bukan opsional.
  - Muncul risiko baru: R11 (super admin kehilangan passphrase) dan R12 (penyalahgunaan oleh pemegang akses). Lihat 02-analysis bagian 4.
  - Desain ini kembali ke SA asli bagian 4.6 (Key Vault) dan 4.9 (Signing Module).
  - Role `SIGNER` di SA bagian 8.2 dilebur ke `SUPER_ADMIN`. Daftar role menjadi: `SUPER_ADMIN, ADMIN, ANALYST, REVIEWER, AUDITOR`. `ADMIN` biasa **tidak** punya akses ke vault.
  - Maker-checker tetap berlaku: SUPER_ADMIN hanya bisa menandatangani transaksi berstatus `APPROVED` yang di-approve oleh REVIEWER selain pembuatnya.

## ADR-004 — Representasi jumlah aset
- **Status:** Accepted
- **Tanggal:** 2026-10-01
- **Keputusan:** jumlah disimpan dalam base unit sebagai `NUMERIC(78,0)` di DB dan `bigint` di kode. Nilai fiat dihitung dengan decimal library.
- **Alasan:** float menyebabkan error pembulatan, sedangkan 78 digit cukup untuk uint256.

## ADR-005 — Status address multi-dimensi
- **Status:** Accepted
- **Tanggal:** 2026-10-01
- **Keputusan:** status dipecah menjadi `activity_status`, `balance_status`, `authorization_status`, `recovery_status`, dan `review_flag` (lihat 02-analysis bagian 2.2).

## ADR-006 — Sumber data aktivitas
- **Status:** Accepted
- **Tanggal:** 2026-10-01
- **Keputusan:** RPC untuk saldo + nonce, explorer API (Etherscan-compatible) untuk riwayat dan timestamp. Hasil kedua sumber disilang-cek.

## ADR-007 — Approval maker-checker
- **Status:** Accepted
- **Tanggal:** 2026-10-01
- **Keputusan:** pembuat transaksi/destination tidak bisa meng-approve-nya sendiri. Approval kedaluwarsa jika fee/saldo berubah melebihi toleransi.

## ADR-008 — Arsitektur & enkripsi Key Vault
- **Status:** Accepted
- **Tanggal:** 2026-10-01
- **Keputusan:**
  1. **Service terpisah `signer/`**: proses Node.js sendiri dengan **database sendiri** (`da_vault`, user DB berbeda). Service ini tidak terekspos ke internet, hanya bisa diakses oleh backend lewat jaringan internal + shared secret/mTLS.
  2. **Envelope encryption:**
     ```text
     passphrase SUPER_ADMIN ──Argon2id(salt)──► KEK (tidak disimpan)
     KEK ──AES-256-GCM──► membungkus Master Key (MK, 32 byte acak)  → disimpan: wrapped_mk
     MK  ──AES-256-GCM──► mengenkripsi tiap private key              → disimpan: ciphertext + iv + tag
     ```
     - Passphrase **tidak pernah disimpan**. Tanpa passphrase, isi `da_vault` tidak bisa dibuka meskipun server dan backup DB dicuri.
     - MK juga dibungkus oleh **recovery passphrase** (salinan kedua) yang disimpan offline, misalnya kertas di brankas. Ini mitigasi R11.
     - Ganti passphrase cukup membungkus ulang MK, tanpa perlu mengenkripsi ulang semua key.
  3. **Sesi unlock:** SUPER_ADMIN memasukkan passphrase, lalu MK berada di memori `signer` selama maksimal `VAULT_UNLOCK_TTL_MINUTES` (default 10). Vault terkunci otomatis saat timeout, logout, atau restart service.
  4. **Import key:** key yang di-import (hex private key, atau seed + derivation path) diverifikasi dulu bahwa address turunannya **sama** dengan address di inventory yang punya `owner_reference`. Jika tidak cocok, import ditolak.
  5. **Signing:** `signer` hanya menerima perintah sign untuk `transaction_id` berstatus `APPROVED`. Payload diambil dan diverifikasi ulang dari data yang di-approve. Key didekripsi di memori, dipakai, lalu langsung dibuang dari variabel. Yang keluar dari service hanya signed tx atau signature.
- **Alasan:** memisahkan key dari DB aplikasi (SA bagian 4.6) dan memastikan "hanya super admin yang bisa akses" secara kriptografis, bukan sekadar lewat pengecekan role.
- **Konsekuensi:** jika passphrase utama dan recovery passphrase sama-sama hilang, **semua key hilang permanen**. Prosedur penyimpanan recovery passphrase wajib ada di runbook.

## ADR-009 — Fitur melihat (reveal) private key
- **Status:** Accepted
- **Tanggal:** 2026-10-01
- **Keputusan:** SUPER_ADMIN bisa melihat private key lewat alur *break-glass*:
  1. Login ulang dengan password, lalu kode MFA (TOTP), lalu passphrase vault.
  2. Key tampil di modal dalam keadaan tersamar (klik untuk melihat), lalu otomatis tertutup setelah 60 detik.
  3. Response API memakai `Cache-Control: no-store` dan tidak pernah di-log. Yang tercatat di audit log hanya `KEY_REVEALED` beserta address, user, IP, dan waktu, **tanpa isi key**.
  4. Rate limit, misalnya maksimal 3 reveal per jam.
  5. Fitur bisa dimatikan total lewat env `KEY_REVEAL_ENABLED=false`.
- **Catatan:** ini satu-satunya alur yang mengirim private key ke browser. Setiap reveal memperbesar risiko kebocoran (screenshot, malware di PC super admin). Disarankan dipakai seperlunya saja dan dimatikan di produksi jika tidak dibutuhkan.

## ADR-010 — Konvensi skema database (Fase 2)
- **Status:** Accepted
- **Tanggal:** 2026-10-02
- **Keputusan:**
  1. **Aturan penting dijaga juga di level database**, tidak hanya di kode aplikasi. Bentuknya CHECK constraint, partial unique index, dan trigger yang ditulis manual di migrasi `20261002000000_init`:
     - `audit_logs` tidak bisa di-UPDATE, DELETE, maupun TRUNCATE.
     - `owner_reference` tidak boleh kosong.
     - Jumlah aset tidak boleh negatif.
     - Satu network hanya punya satu aset native.
     - Penyetuju approval harus berbeda dari pengajunya.
  2. Tabel `authorizations` (SA 5.5) sekaligus menyimpan metadata dokumen otorisasi (`document_sha256`, `document_path`). Rencana tabel terpisah `authorization_documents` dibatalkan.
  3. URL RPC **tidak** disimpan di DB, karena biasanya mengandung API key. Tabel `networks.rpc_url_env` hanya menyimpan **nama** env var-nya (misalnya `SEPOLIA_RPC_URL`).
  4. Prisma 7: client di-generate ke `backend/src/generated/prisma` (tidak di-commit, dibuat ulang saat `pnpm install`), koneksi lewat `@prisma/adapter-pg`, dan konfigurasinya di `backend/prisma.config.ts` yang membaca `.env` root.
  5. Repository mengonversi `Decimal` ↔ `bigint` di batas lapisan (`repositories/amount.ts`), jadi service dan domain hanya melihat `bigint`.
  6. Setiap kali test jalan, setup **membuat database baru** bernama unik (`<nama>_test_<waktu>_<acak>`), menerapkan migrasi dengan `prisma migrate deploy` (hanya menambah), lalu menghapus **hanya** database itu setelah test selesai. Tidak ada database yang sudah ada (dev, maupun milik proyek lain di server yang sama) yang di-reset atau disentuh. `prisma migrate reset` sengaja tidak dipakai.
- **Alasan:** pertahanan berlapis. Bug di aplikasi atau akun DB yang bocor tetap tidak bisa melanggar aturan inti.

## ADR-011 — Database dev: PostgreSQL native (sementara)
- **Status:** Superseded oleh ADR-013
- **Tanggal:** 2026-10-02
- **Konteks:** Docker Desktop di mesin dev gagal start. PostgreSQL 16 (port 5433) dan 18 (port 5432) sudah terpasang native.
- **Keputusan:** dev memakai PostgreSQL **16 native di port 5433**. Setup DB dilakukan dengan `scripts/db/native-setup.sql`. Docker tetap didukung, dan port host-nya bisa diatur lewat `POSTGRES_HOST_PORT` karena 5432 sudah terpakai.
- **Catatan keamanan:** instance native mendengarkan di `0.0.0.0`, tetapi `pg_hba.conf` sudah diperiksa (2026-10-02) dan hanya mengizinkan `127.0.0.1/32` dan `::1/128` dengan `scram-sha-256`, jadi koneksi dari luar ditolak. Jangan menambah aturan `host` untuk jaringan lain, karena DB vault (`da_vault`) juga ada di sini.
- **Isolasi terverifikasi:** user `da` ditolak saat connect ke `da_vault` (`permission denied ... CONNECT privilege`).
- **Akses superuser:** password `postgres` PG 16 di-reset pada 2026-10-02 dan disimpan di `%APPDATA%\postgresql\pgpass.conf` (profil Windows user, dibaca otomatis oleh `psql`). Password itu tidak ada di repo. Server PG 16 ini juga dipakai proyek lain (`whale_tracker`).

## ADR-012 — Autentikasi, session, dan MFA (Fase 3)
- **Status:** Accepted
- **Tanggal:** 2026-10-02
- **Keputusan:**
  1. **Session di database** (tabel `sessions`), bukan JWT. Cookie hanya berisi token acak 256-bit, sedangkan DB menyimpan SHA-256-nya. Dengan begitu session bisa dicabut seketika (logout, user dinonaktifkan, role diubah, terlalu banyak kode MFA salah). Idle timeout 30 menit, maksimum 12 jam.
  2. **MFA TOTP wajib untuk SUPER_ADMIN, ADMIN, dan REVIEWER.** ADMIN ditambahkan karena ADMIN bisa membuat akun REVIEWER. Tanpa MFA, akun ADMIN yang dibobol bisa membuat reviewer palsu dan mengakali maker-checker.
  3. Status session: `MFA_SETUP_REQUIRED`, `MFA_PENDING`, `ACTIVE`. Hanya session `ACTIVE` yang lolos pemeriksaan permission. Session `MFA_PENDING` tidak bisa mendaftarkan authenticator baru.
  4. **Anti-enumerasi:** semua kegagalan login dijawab `INVALID_CREDENTIALS` dengan pesan yang sama, termasuk akun terkunci atau nonaktif. Untuk email yang tidak terdaftar, waktu respons disamakan dengan verifikasi hash dummy. Alasan sebenarnya hanya dicatat di audit log.
  5. **CSRF:** cookie `SameSite=Strict`, request yang mengubah data dengan `Origin` selain `APP_ORIGIN` ditolak, dan hanya body JSON yang diterima.
  6. **SUPER_ADMIN hanya lewat CLI** (`user:create`). API menolak memberi, mencabut, maupun mengubah akun SUPER_ADMIN. ADMIN tidak bisa mengubah role atau status dirinya sendiri. SUPER_ADMIN tidak punya permission manajemen user (pemisahan tugas).
  7. Kosakata RBAC (`ROLES`, `PERMISSIONS`) berada di `@da/shared/rbac` agar backend dan frontend memakai sumber yang sama. Unit test memastikan daftar itu sama dengan enum `Role` di DB.
- **Risiko yang diterima:** pada login pertama, akun yang wajib MFA mendaftarkan authenticator setelah login dengan password saja. Siapa pun yang mengetahui password awal bisa mendaftarkan perangkatnya lebih dulu. Mitigasinya: password awal disampaikan lewat jalur aman dan setup MFA dilakukan segera. Reset MFA (perangkat hilang) dikerjakan di Fase 13.
- **Batasan:** rate limiter login ada di memori satu proses. Jika API dijalankan lebih dari satu instance, rate limiter harus dipindah ke Redis (Fase 13).

## ADR-013 — Database dev: Docker
- **Status:** Accepted (menggantikan ADR-011)
- **Tanggal:** 2026-10-02
- **Konteks:** Docker Desktop kini berjalan dengan backend Hyper-V.
- **Keputusan:** dev memakai `docker compose`: Postgres di **port host 5434** (`POSTGRES_HOST_PORT`, karena 5432/5433 dipakai PostgreSQL native) dan Redis di 6379. Database terisolasi dari proyek lain di PostgreSQL native.
- **Catatan:** PostgreSQL 16 native (port 5433) masih berisi database proyek ini dari Fase 2 dan tidak dipakai lagi. Hapus dengan `DROP DATABASE digital_archaeology; DROP DATABASE da_vault; DROP USER da; DROP USER da_vault;` jika sudah tidak dibutuhkan.

## ADR-014 — Inventaris address (Fase 4)
- **Status:** Accepted
- **Tanggal:** 2026-10-02
- **Keputusan:**
  1. **Checksum EIP-55 ditegakkan:** address huruf campuran dengan checksum salah **ditolak** (kemungkinan salah ketik), bukan dikoreksi diam-diam. Address huruf kecil/besar semua diterima, lalu disimpan dalam bentuk checksum. Zero address ditolak. Validasi ada di `ChainAdapter.checkAddress` agar chain lain (Bitcoin) tinggal menambah adapter.
  2. **Arsip, bukan hapus:** `addresses.archived_at`. Address arsip disembunyikan dari daftar dan tidak akan di-scan (Fase 5), tetapi histori scan, transaksi, dan audit tetap utuh. Address arsip bersifat read-only sampai dipulihkan.
  3. **Import CSV dua langkah:** preview (tanpa menyimpan) lalu simpan. Saat menyimpan, server **memvalidasi ulang** file secara penuh (hasil preview dari client tidak dipercaya). Baris valid disimpan dengan `skipDuplicates`, jadi import ulang aman. Audit mencatat SHA-256 file, bukan isinya.
  4. **Network:** `chainType`, `chainId`, dan `isTestnet` tidak bisa diubah setelah dibuat, supaya network testnet tidak bisa "dibalik" menjadi mainnet. Network mainnet hanya bisa dibuat jika `NETWORK_MODE=mainnet`, dan UI hanya membuat testnet.
  5. Aset native dibuat bersamaan dengan network dalam satu transaksi.
- **Catatan:** pencarian memakai `ILIKE` (`contains` insensitive). Jika inventaris sudah ratusan ribu baris, tambahkan index trigram (`pg_trgm`).

## ADR-015 — Scanner: sumber data & definisi "tidak aktif" (Fase 5)
- **Status:** Accepted
- **Tanggal:** 2026-10-02
- **Keputusan:**
  1. **Basis inaktivitas = transaksi keluar terakhir** (keputusan pemilik projek). Hanya pemegang key yang bisa mengirim, jadi token spam atau airdrop yang masuk tidak "menghidupkan" wallet. Address yang tidak pernah mengirim diukur sejak aktivitas pertamanya. Address tanpa riwayat = `INACTIVE` dengan `inactive_days` null. Batas: `inactive_days >= threshold` → INACTIVE (SA 4.3).
  2. **RPC = sumber kebenaran saldo dan nonce; Etherscan API v2 = riwayat.** Transaksi keluar hanya dihitung dari tx normal yang `from` = address (transfer token "dari" address bisa ditarik spender lewat `approve`, sehingga tidak dihitung). Transaksi masuk = tx normal + internal + transfer token ke address.
  3. **Tanda review, bukan tebakan:** `NONCE_MISMATCH`, `HISTORY_TRUNCATED` (> 10.000 per jenis), dan `BALANCE_WITHOUT_HISTORY`. Address tetap diberi status, tetapi ditandai untuk dicek manusia.
  4. **Satu scan per network pada satu waktu**, worker BullMQ concurrency 1, throttle Etherscan dibagi untuk semua network (default 4 request/detik). Proses idempoten (address yang sudah tercatat di-skip), sehingga job yang terhenti aman dilanjutkan. Kegagalan per address dicatat di `scan_results.error_code`, dan data lama address tidak ditimpa.
  5. **Rahasia tidak bocor:** URL RPC dan API key tidak pernah masuk pesan error, log, maupun response. `/health/rpc` hanya menampilkan nama network, chain id, dan nomor blok.
  6. Kriteria saldo (min/max) tidak menyaring address yang di-scan, hanya menandai hasil "sesuai kriteria" (inactive + saldo native dalam rentang).
- **Batasan yang diketahui:** worker berjalan di proses yang sama dengan API. Jika beban naik, pindahkan ke proses terpisah (kode sudah terpisah di `jobs/scan-queue.ts`). Filter "sesuai kriteria" dihitung di memori dari hasil inactive; jika satu scan berisi puluhan ribu address, pindahkan saldo native ke kolom tersendiri.

## ADR-016 — Valuasi & penjadwal (Fase 6)
- **Status:** Accepted
- **Tanggal:** 2026-10-03
- **Keputusan:**
  1. **Mata uang referensi USD** (`FIAT_CURRENCY`, juga mendukung IDR). Nilai hanya dihitung dari snapshot dengan mata uang yang sama. Jika mata uang diganti, nilai lama tidak dicampur.
  2. **Sumber harga CoinGecko** (`/simple/price`, `precision=full`). Key opsional dikirim di header, bukan di URL. Setiap pembaruan disimpan sebagai `price_snapshots` (harga, sumber, waktu) dan tidak pernah ditimpa.
  3. **Tanpa float:** harga JSON diubah ke string desimal dengan representasi terpendek yang persis (`String(number)`) lalu dihitung dengan `decimal.js` presisi 120 digit. Hasil dibulatkan 8 desimal (ROUND_HALF_UP) dan disimpan `NUMERIC(38,8)`. Frontend memformat string, tidak pernah mem-parse ke `Number`.
  4. **Testnet = simulasi:** aset testnet diberi `price_id` padanan mainnet (Sepolia ETH → `ethereum`) agar alur kelayakan ekonomis (Fase 8) bisa diuji, tetapi nilainya **selalu** dilabeli SIMULASI dan dijumlahkan **terpisah** dari nilai nyata (`value` vs `simulatedValue`). Keputusan pemilik projek.
  5. **Penjadwal BullMQ** (`maintenance` queue, job scheduler, aman untuk banyak instance): harga tiap 60 menit dan scan semua network aktif setiap hari pukul 02:00 `Asia/Jakarta`. Scan terjadwal: `created_by = NULL`, `trigger = SCHEDULED`, dan audit `SCAN_SCHEDULED` dengan aktor SYSTEM. Network tanpa konfigurasi atau tanpa address dilewati dengan log. Scan hanya membaca (aturan keras #5).
  6. **Dashboard per network** (`?networkId=`) selain ringkasan global.
  7. **CSV:** RFC 4180, BOM UTF-8, CRLF, dan proteksi formula injection (OWASP) untuk semua sel. Kolom estimasi, simulasi, dan sumber harga dibuat eksplisit (SA 13: data publik, estimasi, otorisasi, dan status tidak dicampur). Maksimal 50.000 address per export.

## ADR-017 — Implementasi Key Vault (Fase 7a)
- **Status:** Accepted
- **Tanggal:** 2026-10-03
- **Keputusan** (melengkapi ADR-008):
  1. **Seed phrase tidak pernah disimpan** (keputusan pemilik projek). Saat import, seed hanya dipakai untuk menurunkan private key address yang dimaksud lewat derivation path, lalu dibuang. Vault menyimpan key turunan itu dengan `key_type = DERIVED_FROM_MNEMONIC` dan path-nya sebagai informasi. Jika vault bocor, address lain dari seed yang sama tidak ikut terancam.
  2. **AAD mengikat setiap ciphertext ke tujuannya:** Master Key yang dibungkus memakai AAD `da-vault/master-key/v1/main|recovery`, dan key memakai AAD yang berisi chain + address lower-case. Ciphertext yang dipindahkan ke baris lain atau dipakai untuk tujuan lain gagal didekripsi.
  3. **Parameter KDF disimpan per vault** (Argon2id 64 MiB, 3 pass, paralelisme 1). Parameter bisa dinaikkan nanti tanpa merusak bungkus lama.
  4. **HMAC backend ↔ signer:** `HMAC-SHA256(timestamp \n METHOD \n path+query \n sha256(body mentah))`, jendela ±60 detik, perbandingan constant-time, dan signature diingat 120 detik (anti-replay). Body diverifikasi dari teks mentah, bukan hasil serialisasi ulang. Secret ≥ 32 karakter.
  5. **Signer hanya bind ke loopback** kecuali `SIGNER_ALLOW_NON_LOOPBACK=true` (untuk jaringan container privat di produksi).
  6. **Error tidak pernah memuat input:** validasi hanya menyebut nama field, dan passphrase salah dijawab "Wrong passphrase" dengan event `UNLOCK_FAILED`. Batas 5 kegagalan per 15 menit berlaku untuk unlock, ganti passphrase, dan recovery sekaligus.
  7. Vault tetap **terkunci** setelah init: unlock selalu merupakan aksi terpisah yang tercatat.
  8. **(7b) Konfirmasi ulang 5 menit** (password + TOTP lewat `/api/auth/reauth`) untuk init, unlock, ganti passphrase, recovery, import, dan reveal. Lock tidak perlu konfirmasi karena selalu aman.
  9. **(7b) Reveal** meminta tiga hal sekaligus: konfirmasi ulang ≤ 5 menit, **kode TOTP baru** di request itu (sekali pakai), dan passphrase vault. Master Key dibuka dari passphrase (`withPassphrase`), terlepas dari status unlock, dan kegagalannya dihitung bersama percobaan unlock.
  10. **(7b) Satu key EVM = satu address di semua network EVM.** Vault menyimpan key per (chain, address). Daftar key menampilkan **semua** entri inventaris yang cocok di network mana pun.
  11. **(7b) Logout SUPER_ADMIN mengunci vault** (best effort; logout tidak pernah gagal karena signer).
  12. **(7b) Pesan error 4xx bersifat tetap:** error handler backend tidak lagi meneruskan pesan error client dari Fastify/library, karena pesan itu suatu saat bisa mengutip body request yang berisi passphrase/key.
- **Batasan yang diketahui (dicatat dengan jujur):**
  - Passphrase datang sebagai string JavaScript dan tidak bisa ditimpa paksa sebelum garbage collection. Master Key, KEK, dan key yang didekripsi disimpan sebagai `Buffer` lalu ditimpa nol setelah dipakai, tetapi salinan sementara di internal V8/OpenSSL di luar kendali aplikasi.
  - Penghitung kegagalan unlock ada di memori proses signer, sehingga reset saat restart. Argon2id (64 MiB per percobaan) tetap membuat tebakan massal mahal.
  - Di dev, satu `.env` dipakai bersama oleh backend dan signer. **Di produksi** signer harus mendapat env sendiri (`VAULT_DATABASE_URL` tidak boleh ada di env backend). Ini masuk checklist Fase 14.

## ADR-018 — Ownership verification (Fase 7c)
- **Status:** Accepted
- **Tanggal:** 2026-10-03
- **Konteks:** SA 4.5 meminta bukti kepemilikan sebelum recovery. Perlu memutuskan cara menyimpan dokumen otorisasi, siapa boleh memverifikasi, dan bagaimana signer boleh menandatangani tanpa menjadi "tanda tangan apa saja".
- **Keputusan:**
  1. **Dokumen tidak diunggah.** Browser menghitung SHA-256 file (`crypto.subtle`); server hanya menyimpan sidik jari (CHECK `^[0-9a-f]{64}$`) + nama file. Dokumen asli disimpan pemilik di luar sistem dan bisa dicocokkan kapan saja. Ini menghindari penyimpanan file sensitif (KTP, surat kuasa) dan kebutuhan enkripsi file pada tahap ini.
  2. **Format challenge tunggal** di `@da/shared` (`buildChallengeMessage` / `parseChallengeMessage`): judul tetap, address, network + chainId, ID otorisasi, nonce 32 byte, waktu terbit dan kedaluwarsa. Dipakai backend untuk membuat pesan dan oleh signer untuk menolak pesan lain.
  3. **Signer hanya menandatangani challenge.** `POST /vault/keys/sign-challenge` mem-parse pesan dengan parser ketat, menolak address yang berbeda dan challenge kedaluwarsa, lalu mencatat `MESSAGE_SIGNED` dengan SHA-256 pesan (bukan isinya). Signer tidak punya endpoint "sign arbitrary message".
  4. **Sekali pakai, atomik.** Challenge dikonsumsi (`used_at`) dengan update bersyarat **sebelum** signature dievaluasi, sehingga dua kiriman bersamaan tidak bisa sama-sama dinilai, dan signature salah membakar challenge (tidak ada tebak-ulang). Kegagalan memanggil signer (vault terkunci, signer mati) tidak membakar challenge.
  5. **Permission baru `ownership:verify`** untuk ANALYST (pengelola inventaris) dan SUPER_ADMIN. Jalur vault tetap butuh `vault:manage` + konfirmasi ulang ≤ 5 menit. Semua role bisa melihat (`authorizations:read`).
  6. **Status:** otorisasi baru = PENDING; address naik ke PENDING kecuali sudah VERIFIED (otorisasi tambahan tidak menurunkan status). Verifikasi berhasil → otorisasi VERIFIED + `verified_at`, address VERIFIED. Signature salah → challenge REJECTED, otorisasi tetap PENDING. Otorisasi yang lewat `expires_at` ditampilkan EXPIRED dan tidak bisa diverifikasi (juga bila kedaluwarsa saat challenge masih terbuka).
- **Batasan yang diketahui:**
  - `verifyMessage` (ecrecover) hanya untuk EOA; smart-contract wallet (EIP-1271) belum didukung.
  - `authorization_status` address tidak otomatis turun saat otorisasi kedaluwarsa. **Fase 8/9 wajib memeriksa otorisasi VERIFIED yang masih berlaku**, bukan hanya kolom status address.
  - Review otorisasi oleh REVIEWER (`authorizations:review`) belum dipakai; dipertimbangkan bersama maker-checker di Fase 9.
- **Alternatif:** unggah dokumen terenkripsi (ditunda, butuh penyimpanan file + kunci), endpoint sign generik di signer (ditolak: bisa disalahgunakan untuk menandatangani permit/transaksi off-chain).

## ADR-019 — Hasil review keamanan Fase 7 (7d)
- **Status:** Accepted
- **Tanggal:** 2026-10-04
- **Konteks:** review menyeluruh signer + endpoint vault (prompt P7d). Tidak ada jalur kebocoran key/passphrase lewat log, error, response, atau audit. Delapan kelemahan ditemukan dan diperbaiki, masing-masing dengan test regresi yang terbukti gagal pada kode lama.
- **Keputusan:**
  1. **Operasi passphrase dijalankan berurutan** (`serial()` di `vault.service`: init, unlock, ganti passphrase, recovery, `withPassphrase`). Throttle 5 salah/15 menit sebelumnya bisa ditembus request paralel (20 dari 20 tebakan dievaluasi), dan banyak Argon2id 64 MiB paralel bisa membuat signer OOM. Konsekuensi: aksi passphrase yang bersamaan saling menunggu (masing-masing < 1 detik).
  2. **Bungkus ulang memakai parameter KDF yang tersimpan** di `vault_config`. Sebelumnya ganti passphrase memakai `DEFAULT_KDF` terbaru, padahal unwrap memakai parameter tersimpan: menaikkan default di rilis berikutnya akan mengunci vault secara permanen (recovery pun tidak menolong). Menaikkan parameter KDF nanti butuh migrasi eksplisit (bungkus ulang kedua passphrase + simpan parameter baru).
  3. **Kuota reveal dipesan sebelum `await`** dan dikembalikan jika tidak ada yang ditampilkan.
  4. **Kebersihan memori:** `aead.open` menghapus buffer hasil `update()`/`final()` (juga saat verifikasi tag gagal, karena `update()` sudah mengeluarkan plaintext yang belum terautentikasi). Import seed menurunkan key langkah demi langkah dengan `@scure/bip32`, lalu menghapus seed BIP-39 dan setiap node HD (`wipePrivateData`).
  5. **Transport backend → signer:** `SIGNER_URL` dengan `http` hanya boleh ke host loopback; selain itu wajib `https`, atau opt-out eksplisit `SIGNER_ALLOW_INSECURE_HTTP=true` yang memunculkan warning saat start. HMAC hanya menjamin integritas, bukan kerahasiaan, sedangkan request membawa passphrase dan (pada reveal) key.
  6. **Reveal setelah konfirmasi ulang tidak di-retry otomatis.** Konfirmasi ulang memakai langkah TOTP saat ini (`mfaLastUsedStep`), sehingga retry dengan kode lama selalu gagal dan ikut menambah hitungan salah MFA. `useSensitive` mendapat opsi `retryAfterReauth: false`. Panel konfirmasi juga menghentikan propagasi submit: sebelumnya panel yang dirender di dalam form import/reveal ikut men-submit form induk (bug yang ditemukan saat perbaikan).
  7. **Matriks test role × endpoint vault lengkap** (semua route `/api/vault/*` + `/api/challenges/:id/vault-signature`, 4 role non-SUPER_ADMIN → 403, signer tidak pernah dipanggil).
- **Diterima / ditunda (dicatat dengan jujur):**
  - Vault hanya terkunci otomatis saat **logout eksplisit** SUPER_ADMIN. Jika sesi berakhir karena kedaluwarsa, idle, dicabut, atau user dinonaktifkan, vault tetap terbuka sampai TTL (default 10 menit, maks. 60). Status unlock berlaku global, bukan per user. Diterima karena dibatasi TTL dan SUPER_ADMIN dipegang satu orang.
  - **Port squatting di loopback:** jika signer mati, proses lain di server yang sama bisa memakai port 4000 dan menerima passphrase unlock berikutnya. Butuh eksekusi kode di server. Mitigasi di Fase 14: TLS dengan sertifikat yang dipin, atau Unix socket dengan izin file.
  - **Hardening proses (Fase 14):** matikan core dump, swap terenkripsi/mati, jangan aktifkan diagnostic report / heap snapshot (isinya env, termasuk `SIGNER_HMAC_SECRET`), env signer terpisah dari backend. OOM tidak bisa ditangkap, sehingga `wipe()` tidak berjalan saat proses mati karena OOM.
  - String JavaScript (passphrase, hex key untuk viem) tetap tidak bisa dihapus (ADR-017).
  - Antrean passphrase tidak dibatasi panjangnya. Request yang menunggu terlalu lama bisa timeout di backend (30 detik) padahal signer tetap memprosesnya kemudian; audit backend lalu mencatat FAILURE untuk aksi yang akhirnya berhasil. Kemungkinannya kecil karena aksi ini hanya untuk SUPER_ADMIN.

---

## Jawaban pertanyaan terbuka (02-analysis bagian 5)

| # | Pertanyaan | Jawaban | Tanggal |
|---|-----------|---------|---------|
| Q1 | Chain mayoritas wallet lama | EVM, sehingga ADR-002 tetap (Sepolia dulu) | 2026-10-01 |
| Q2 | Sendiri / klien + format mandat | Sendiri / tim internal; `owner_reference` umumnya `SELF`/nama tim, dan dokumen mandat klien tidak diprioritaskan di MVP | 2026-10-01 |
| Q3 | Provider RPC & explorer | RPC: bebas (Alchemy/Infura), dirujuk lewat nama env var; explorer: Etherscan API v2 | 2026-10-02 |
| Q4 | Provider harga & mata uang | CoinGecko, USD; testnet = simulasi harga mainnet | 2026-10-03 |
| Q5 | Target deploy | *(putuskan sebelum Fase 14)* | |
| Q6 | Jumlah operator | Lebih dari 3; maker-checker bisa ditegakkan penuh, tiap role dipegang orang berbeda | 2026-10-01 |

---

## Template ADR baru

```markdown
## ADR-0XX — <judul>
- **Status:** Proposed
- **Tanggal:** YYYY-MM-DD
- **Konteks:** <masalah apa yang membuat keputusan ini perlu diambil>
- **Keputusan:** <apa yang dipilih>
- **Alasan:** <kenapa>
- **Alternatif:** <opsi lain yang dipertimbangkan>
- **Konsekuensi:** <dampak ke kode/dokumen/proses>
```
