# 07 — Catatan Keputusan (Architecture Decision Records)

Setiap keputusan penting dicatat di sini agar alasannya tidak hilang. Status yang dipakai: **Proposed** (usulan), **Accepted** (diterima), **Superseded** (diganti oleh ADR lain).

Ubah status dari *Proposed* ke *Accepted* setelah Anda setuju. Semua ADR-001 s/d ADR-009 sudah Accepted per 2026-10-01.

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

---

## Jawaban pertanyaan terbuka (02-analysis bagian 5)

| # | Pertanyaan | Jawaban | Tanggal |
|---|-----------|---------|---------|
| Q1 | Chain mayoritas wallet lama | EVM, sehingga ADR-002 tetap (Sepolia dulu) | 2026-10-01 |
| Q2 | Sendiri / klien + format mandat | Sendiri / tim internal; `owner_reference` umumnya `SELF`/nama tim, dan dokumen mandat klien tidak diprioritaskan di MVP | 2026-10-01 |
| Q3 | Provider RPC & explorer | *(putuskan sebelum Fase 5)* | |
| Q4 | Provider harga & mata uang | *(putuskan sebelum Fase 6)* | |
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
