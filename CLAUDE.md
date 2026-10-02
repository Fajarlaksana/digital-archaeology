# CLAUDE.md — Aturan Proyek Digital Archaeology

File ini dibaca otomatis oleh Claude Code di setiap sesi. Jaga agar tetap singkat dan akurat.

## Ringkasan proyek

Sistem untuk menginventarisasi address kripto **milik sendiri / yang diotorisasi secara sah**, mendeteksi address yang tidak aktif, memverifikasi kepemilikan lewat signature, menilai kelayakan ekonomis, lalu memindahkan aset ke wallet tujuan yang sudah di-approve. Semua langkah dilakukan dengan approval manusia dan tercatat di audit log.

Kebutuhan lengkap: `system_analysis_digital_archaeology.md`. Revisi & keputusan: `docs/02-project-analysis.md`, `docs/07-decisions.md`.

## Aturan keras (jangan pernah dilanggar)

1. Jangan menulis kode yang men-generate, menebak, brute-force, atau mencari private key/seed phrase.
2. Private key/seed **hanya** boleh berada di service `signer/` dan DB `da_vault`, dalam bentuk terenkripsi (envelope encryption, ADR-008). Key tidak boleh ada di DB aplikasi, log, file, env, error message, atau response API. Satu-satunya pengecualian adalah endpoint reveal break-glass untuk SUPER_ADMIN (ADR-009).
3. Hanya role `SUPER_ADMIN` yang boleh import key, unlock vault, memicu signing, dan reveal key. Semua aksi vault wajib MFA + audit log (tanpa isi key).
4. Passphrase vault tidak pernah disimpan. Master key hanya ada di memori `signer` selama sesi unlock.
5. Jangan membuat alur otomatis yang memindahkan aset hanya karena address berstatus tidak aktif.
6. Signer hanya boleh menandatangani transaksi berstatus `APPROVED` oleh REVIEWER yang **berbeda** dari pembuatnya.
7. Address hanya boleh di-scan jika memiliki `owner_reference` / data otorisasi.
8. Jumlah aset disimpan dalam **base unit sebagai string/NUMERIC** (wei, satoshi). Jangan pernah memakai float untuk jumlah aset.
9. Logger wajib me-redact field sensitif (`privateKey`, `seed`, `mnemonic`, `passphrase`, `password`, `token`, `secret`, `signature` mentah).
10. Default jaringan adalah **testnet**. Mainnet hanya aktif lewat konfigurasi eksplisit.

## Stack (lihat docs/07-decisions.md)

- Monorepo pnpm: `backend/` (Node.js + TypeScript + Fastify + Prisma + PostgreSQL + Redis/BullMQ + Pino + Zod + Vitest), `frontend/` (React + Vite + TypeScript + React Router + TanStack Query + Tailwind), `shared/` (`@da/shared`: logger dengan redaction + `AppError`/format error, dipakai backend & signer), `signer/` (service internal Key Vault + signing, DB `da_vault` sendiri, tidak terekspos ke internet).
- TypeScript dikunci `~6.0` (typescript-eslint belum mendukung TS 7). Paket workspace di-import sebagai source TS (`exports` → `src/index.ts`), tanpa build step.
- Selalu pakai `createLogger` dari `@da/shared` dan lempar `AppError(code, ...)`. Jangan pakai `console.*` (lint error).
- Role: `SUPER_ADMIN, ADMIN, ANALYST, REVIEWER, AUDITOR`. Endpoint memeriksa **permission** (bukan role) lewat `guards.permission('x:y')`. Peta role ke permission ada di `backend/src/auth/permissions.ts`. MFA wajib untuk SUPER_ADMIN/ADMIN/REVIEWER (ADR-012).
- Endpoint baru wajib: guard permission, validasi body dengan Zod, dan masuk ke matriks test role × endpoint.
- Integrasi chain melalui interface `ChainAdapter` (`backend/src/chains`), dipilih dengan `chainAdapterFor(chainType)`. Implementasi pertama: EVM (viem) di testnet Sepolia. Jangan memvalidasi address di luar adapter.
- Address tidak pernah dihapus, hanya diarsipkan (`archived_at`). Query untuk scan atau proses lain wajib mengecualikan address yang diarsipkan.
- Baca blockchain hanya lewat `ChainReader` (RPC) dan `ActivityProvider` (explorer) dari `chainClients` (`backend/src/chains/clients.ts`). Inaktivitas dihitung dari transaksi KELUAR (ADR-015). Dalam test pakai `tests/integration/fake-chain.ts`, jangan memanggil jaringan sungguhan (kecuali `*.live.test.ts`).
- Jangan pernah memasukkan URL RPC atau API key ke pesan error atau log.
- Nilai fiat: hitung hanya dengan `domain/valuation.ts` (decimal.js), simpan sebagai string/NUMERIC, dan tampilkan dengan `formatFiat` (tanpa `Number`). Nilai testnet wajib berlabel SIMULASI dan dijumlahkan terpisah (ADR-016).
- Export CSV wajib lewat `lib/csv.ts` (proteksi formula injection).

## Perintah

- Install: `pnpm install` (build script dependency harus diizinkan di `allowBuilds` pada `pnpm-workspace.yaml`)
- Worker scan dan scheduler `maintenance` (harga tiap 60 menit, scan harian 02:00 WIB) berjalan di proses backend dan butuh Redis.
- Infra lokal: `docker compose up -d`. Postgres di port host **5434** (`POSTGRES_HOST_PORT`) dan Redis 6379. DB `digital_archaeology` (user `da`), `da_vault` (user `da_vault`). Lihat ADR-013
- Dev (backend :3000 + frontend :5173): `pnpm dev`
- Test semua: `pnpm test` · satu package: `pnpm --filter backend test`
- Lint, typecheck, format: `pnpm lint`, `pnpm typecheck`, `pnpm format`
- Buat user via CLI (satu-satunya cara untuk SUPER_ADMIN): `pnpm --filter backend user:create --email .. --name .. --role ..`
- DB: `pnpm --filter backend db:migrate` (buat/terapkan migrasi), `db:deploy`, `db:seed`, `db:status`, `db:generate`
- Test DB: setiap run membuat DB baru `<db>_test_<waktu>_<acak>`, menerapkan `migrate deploy`, lalu menghapusnya. Test di-skip jika DB tidak terjangkau. Jangan pernah memakai `prisma migrate reset` pada database yang sudah ada
- Constraint/trigger yang tidak bisa diekspresikan Prisma ditulis manual di `migration.sql` (lihat ADR-010). Jangan dihapus saat membuat migrasi baru

## Cara kerja

- Kerjakan satu fase/tugas dari `docs/03-roadmap.md` per sesi. Jangan melompat ke fase lain.
- Untuk tugas yang besar, buat rencana dulu dan tunggu persetujuan sebelum menulis kode.
- Setiap fitur baru wajib disertai test. Jalankan test, lint, dan typecheck sebelum menyatakan selesai.
- Setelah tugas selesai: centang checklist di `docs/03-roadmap.md`, perbarui `docs/06-manual-guide.md` jika ada fitur yang terlihat user, dan catat keputusan baru di `docs/07-decisions.md`.
- Ikuti konvensi di `docs/05-development-guide.md`.
