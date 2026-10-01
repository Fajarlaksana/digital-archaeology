# 01 — Arah Projek (Project Direction)

## 1. Visi

Menjadi alat yang membantu pemilik sah (atau pihak yang memegang mandat sah) untuk **menemukan kembali, membuktikan kepemilikan, dan mengonsolidasikan** aset kripto yang tercecer di banyak address lama. Prosesnya harus aman, bisa diaudit, dan selalu melibatkan persetujuan manusia.

Satu kalimat: *"Inventaris + bukti kepemilikan + konsolidasi terkontrol untuk wallet lama yang sah."*

## 2. Masalah yang diselesaikan

| Masalah | Dampak | Jawaban sistem |
|---------|--------|----------------|
| Wallet lama tersebar di banyak network dan address | Aset terlupakan, tidak tercatat | Address Inventory + Scanner |
| Tidak tahu address mana yang masih ada saldonya | Waktu terbuang mengecek manual | Scan saldo & aktivitas otomatis |
| Saldo kecil bisa lebih murah dari fee-nya | Transfer malah merugi | Recovery Eligibility Engine |
| Recovery atas nama klien butuh bukti | Risiko hukum dan sengketa | Authorization + signature verification |
| Proses transfer manual rawan salah address | Aset hilang permanen | Destination whitelist + preview + approval |
| Tidak ada jejak siapa melakukan apa | Tidak bisa diaudit | Audit log append-only |

## 3. Pengguna

| Persona | Kebutuhan utama |
|---------|-----------------|
| **Pemilik wallet** (individu/tim) | Melihat seluruh wallet lama, lalu mengonsolidasikan saldonya |
| **Operator recovery** (dengan mandat klien) | Mendokumentasikan otorisasi dan menjalankan recovery secara tertib |
| **Reviewer / Approver** | Memeriksa dan menyetujui transaksi sebelum di-sign |
| **Super Admin** | Satu-satunya pemegang private key: import key ke vault, unlock, menandatangani transaksi yang sudah di-approve, reveal key (break-glass) |
| **Auditor** | Membaca jejak aktivitas, tanpa bisa mengubah apa pun |

## 4. Scope

### 4.1 MVP (yang dibangun dulu)

- 1 chain: **EVM testnet (Sepolia)**. Lihat ADR-002 di [07-decisions.md](07-decisions.md).
- Import address (manual/CSV) dengan `owner_reference` yang wajib diisi.
- Scan saldo native, saldo token ERC-20 (dari daftar token yang dikonfigurasi), dan aktivitas terakhir.
- Hitung periode tidak aktif dan estimasi nilai fiat.
- Verifikasi kepemilikan lewat challenge-signature (EIP-191 / `personal_sign`).
- Whitelist wallet tujuan dengan approval.
- Eligibility engine (net value setelah fee).
- **Key Vault** (service `signer/` terpisah, terenkripsi dengan passphrase SUPER_ADMIN): import key, unlock berbatas waktu, reveal break-glass.
- Preview transaksi → approval oleh REVIEWER (bukan pembuatnya) → **signing oleh SUPER_ADMIN lewat Key Vault** → broadcast → tracking konfirmasi.
- RBAC (5 role: SUPER_ADMIN, ADMIN, ANALYST, REVIEWER, AUDITOR), MFA wajib untuk SUPER_ADMIN & REVIEWER, audit log, dashboard, dan laporan CSV.

### 4.2 Setelah MVP

- Bitcoin (UTXO, PSBT, BIP-322 message signing).
- Chain EVM lain (Polygon, BSC, Arbitrum, dan sebagainya), cukup lewat konfigurasi.
- Upgrade Key Vault ke KMS/HSM (opsional, butuh keputusan keamanan terpisah).
- Laporan PDF, notifikasi, dan scheduler yang lebih kaya.

### 4.3 Non-goals (tidak akan pernah dibangun)

- Pencarian, generate, atau brute-force private key/seed phrase.
- Scan address acak/milik publik untuk "mencari wallet mati".
- Pemakaian database credential bocoran.
- Transfer otomatis tanpa approval manusia.
- Menyimpan private key **tidak terenkripsi**, atau di luar service `signer/`.

## 5. Milestone produk

Setiap milestone menghasilkan sesuatu yang **sudah berguna sendiri**, jadi projek tetap bernilai meskipun berhenti di tengah jalan.

| Milestone | Isi | Nilai yang didapat | Fase roadmap |
|-----------|-----|--------------------|--------------|
| **M1 — Watch-only Inventory** | Fondasi, auth, inventory, scanner, valuasi, dashboard read-only | Tahu persis aset apa saja yang ada dan di mana. Risiko nol karena tidak ada transfer | Fase 1–6 |
| **M2 — Proof of Ownership** | Challenge-signature, dokumen otorisasi, eligibility | Bukti kepemilikan yang terdokumentasi dan daftar aset yang layak dipulihkan | Fase 7–8 |
| **M3 — Controlled Recovery (testnet)** | Destination whitelist, preview, approval, Key Vault + signing oleh SUPER_ADMIN, broadcast | Alur end-to-end jalan di testnet | Fase 9–11 |
| **M4 — Production Ready** | Laporan, hardening keamanan, monitoring, deploy | Siap dipakai dengan aset nyata | Fase 12–14 |

## 6. Prinsip desain

1. **Read-only first.** Bagian yang membaca data dibangun dan distabilkan dulu, baru bagian yang memindahkan aset.
2. **Testnet first.** Mainnet harus diaktifkan secara eksplisit lewat konfigurasi.
3. **Human-in-the-loop.** Tidak ada transfer tanpa approval dari orang kedua (maker-checker).
4. **Key isolation.** Private key hanya ada di service `signer/` (terpisah dari aplikasi utama), terenkripsi dengan passphrase yang hanya diketahui SUPER_ADMIN, dan didekripsi di memori hanya saat dipakai.
5. **Adapter per chain.** Logika bisnis tidak tahu detail chain, semuanya lewat interface `ChainAdapter`.
6. **Audit everything.** Setiap aksi yang mengubah state tercatat, dan audit log tidak bisa diedit.
7. **Exact money.** Semua jumlah disimpan dalam base unit (integer string), tidak memakai float.

## 7. Stack teknologi (rekomendasi)

| Lapisan | Pilihan | Alasan |
|---------|---------|--------|
| Bahasa | TypeScript (backend & frontend) | Satu bahasa, type-safe, ekosistem web3 kuat |
| Runtime | Node.js LTS (≥ 22) | Stabil, didukung semua library di bawah |
| Monorepo | pnpm workspaces | Ringan, cocok untuk `backend/` + `frontend/` |
| API | Fastify + Zod | Cepat, validasi skema jelas |
| ORM / DB | Prisma + PostgreSQL 16 | Migrasi rapi, tipe `Decimal`/`NUMERIC` untuk jumlah |
| Queue / Scheduler | Redis + BullMQ | Job scan berkala dan retry |
| Logging | Pino (dengan `redact`) | Mudah menyensor field sensitif |
| Chain EVM | viem | Modern, typed, dukung signing & verify message |
| Frontend | React + Vite + TanStack Query + Tailwind | Cepat dibangun, state server rapi |
| Key Vault | Service `signer/` (Node.js) + DB `da_vault` + Argon2id + AES-256-GCM | Key terisolasi dari aplikasi utama, terkunci tanpa passphrase SUPER_ADMIN |
| Wallet connect (opsional) | wagmi / injected wallet | Untuk verifikasi address yang key-nya tidak disimpan di vault |
| Test | Vitest (+ Playwright untuk E2E nanti) | Cepat, kompatibel dengan TS |
| Infra lokal | Docker Compose (Postgres, Redis) | Setup satu perintah |

Stack ini adalah **rekomendasi default**. Kalau ada yang ingin diganti (misalnya NestJS, Laravel, atau Python), ubah ADR-001 di [07-decisions.md](07-decisions.md) **sebelum** Fase 1, karena prompt di [04-prompting.md](04-prompting.md) mengikuti stack ini.

## 8. Ukuran keberhasilan

- 100% address di sistem punya `owner_reference`.
- Tidak ada satu pun private key/seed yang muncul di DB aplikasi, log, atau network tab browser, kecuali saat reveal break-glass oleh SUPER_ADMIN (diverifikasi dengan test).
- Dump DB `da_vault` tanpa passphrase tidak bisa dipakai untuk memulihkan key (diverifikasi dengan test).
- 100% transaksi yang di-broadcast punya approval dari user berbeda dan tercatat di audit log.
- Hasil scan konsisten: menjalankan scan dua kali tanpa ada aktivitas baru menghasilkan data yang sama.
- Alur M3 lulus end-to-end di testnet sebelum mainnet diaktifkan.
