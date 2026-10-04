# 05 — Development Guide

Panduan teknis untuk developer: setup lokal, struktur folder, konvensi, dan testing.

---

## 1. Prasyarat

| Tool | Versi | Cek |
|------|-------|-----|
| Git | terbaru | `git --version` |
| Node.js | LTS aktif (≥ 22) | `node -v` |
| pnpm | 12.x (dikunci di `packageManager`) | `pnpm -v` (install: `corepack enable`) |
| Docker Desktop | terbaru | `docker compose version` |
| Wallet browser | MetaMask / Rabby (untuk testnet) | — |
| Editor | VS Code + ESLint + Prettier + Prisma extension | — |

Akun eksternal (gratis untuk testnet):
- RPC provider: Alchemy atau Infura (endpoint Sepolia)
- Explorer API: Etherscan (API key, bisa dipakai untuk Sepolia)
- Harga: CoinGecko (opsional key)
- Faucet Sepolia untuk mengisi wallet testnet

## 2. Setup lokal

```bash
git clone <repo> && cd digital-archaeology
corepack enable
pnpm install
cp .env.example .env            # lalu isi MFA_ENCRYPTION_KEY dan SEED_DEV_PASSWORD (lihat komentar di file)
docker compose up -d            # PostgreSQL (2 DB) di 127.0.0.1:5434 + Redis di 127.0.0.1:6379
pnpm --filter backend db:deploy # terapkan migrasi
pnpm --filter backend db:seed   # Sepolia + aset + user dev (admin/analyst/reviewer/auditor@dev.local)
pnpm dev                        # backend + frontend
```

Alternatif tanpa Docker (ADR-011): PostgreSQL native, setup dengan `psql -U postgres -h 127.0.0.1 -p <port> -f scripts/db/native-setup.sql`, lalu sesuaikan port di `DATABASE_URL`.

- Backend: `http://127.0.0.1:3000` (cek `GET /health`, `/health/database`, `/health/rpc`)
- Frontend: `http://127.0.0.1:5173` (Vite mem-proxy `/api` dan `/health` ke backend)
- Reset database lokal (hapus semua data): `docker compose down -v`, lalu `docker compose up -d`. Script `docker/postgres/init` hanya jalan saat volume pertama kali dibuat.
- Signer (internal, mulai Fase 7): `http://127.0.0.1:4000`. Jangan membuka port ini ke jaringan luar.

## 3. Struktur folder

Diturunkan dari SA bagian 16. Penyesuaiannya: migrasi DB dipindah ke Prisma, dan ditambah folder `chains/` serta `domain/`.

```text
digital-archaeology/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/
│   │   └── seed.ts
│   ├── src/
│   │   ├── config/          # env schema (Zod), konstanta
│   │   ├── controllers/     # route Fastify: parsing request → service
│   │   ├── services/        # logika bisnis (scan, eligibility, approval, ...)
│   │   ├── domain/          # pure function & tipe: analyzer, eligibility, money
│   │   ├── repositories/    # akses DB via Prisma
│   │   ├── chains/
│   │   │   ├── types.ts     # ChainAdapter, BalanceProvider, ActivityProvider
│   │   │   └── evm/         # implementasi viem + explorer
│   │   ├── pricing/         # PriceProvider
│   │   ├── auth/            # session, RBAC, permission map
│   │   ├── audit/           # audit log service (insert-only)
│   │   ├── jobs/            # BullMQ queues, workers, scheduler
│   │   ├── lib/             # logger, errors, http client
│   │   └── server.ts
│   ├── tests/
│   │   ├── unit/
│   │   └── integration/
│   └── package.json
├── signer/                  # service internal Key Vault (ADR-008) — TIDAK terekspos ke internet
│   ├── prisma/
│   │   └── schema.prisma    # DB da_vault: vault_config, vault_keys, vault_events
│   ├── src/
│   │   ├── crypto/          # Argon2id, AES-256-GCM, wrap/unwrap (pure, wajib unit test)
│   │   ├── vault/           # init, unlock/lock + TTL, import, reveal
│   │   ├── signing/         # sign tx & message untuk payload APPROVED saja
│   │   ├── auth/            # verifikasi HMAC request dari backend
│   │   └── server.ts
│   ├── tests/
│   └── package.json
├── shared/                  # @da/shared — logger (redaction) + AppError/format error
│   ├── src/
│   └── tests/
├── frontend/
│   ├── src/
│   │   ├── pages/           # Dashboard, Networks, Addresses, Scans, Key Vault, Signing, ...
│   │   ├── components/
│   │   ├── services/        # API client
│   │   ├── hooks/
│   │   └── utils/
│   └── package.json
├── docs/
├── docker/postgres/init/    # membuat DB digital_archaeology + da_vault dengan user terpisah
├── docker-compose.yml
├── pnpm-workspace.yaml
├── .env.example
├── CLAUDE.md
└── README.md
```

**Aturan lapisan:** `controllers → services → (domain, repositories, chains)`. Folder `domain/` tidak boleh meng-import Prisma, Fastify, atau viem, supaya isinya mudah dites sebagai pure function.

**Aturan signer:**
- `backend/` tidak pernah meng-import kode dari `signer/` (dan sebaliknya). Komunikasi keduanya hanya lewat HTTP internal ber-HMAC.
- `backend/` tidak punya kredensial DB `da_vault`.
- Di `signer/`, key yang sudah didekripsi hanya hidup di scope fungsi signing. Jangan disimpan di variabel modul/global, cache, maupun objek error.

### 3.1 Kriptografi vault (ringkas)

```text
passphrase ──Argon2id(salt, m=64MiB, t=3, p=1)──► KEK
KEK  ─AES-256-GCM─► wrapped_mk            (vault_config)
recovery passphrase ─Argon2id─► KEK2 ─► wrapped_mk_recovery
MK   ─AES-256-GCM─► ciphertext per key    (vault_keys: ciphertext, iv, auth_tag)
```

- Library: `argon2` (npm) untuk KDF dan `node:crypto` (`aes-256-gcm`) untuk enkripsi. Jangan menulis primitive kripto sendiri.
- IV 12 byte acak untuk **setiap** enkripsi. Jangan pernah memakai ulang IV dengan kunci yang sama.
- Parameter Argon2id disimpan di `vault_config` agar bisa dinaikkan nanti.

## 4. Konvensi kode

### 4.1 Umum
- TypeScript `strict: true`. Jangan pakai `any` kecuali ada alasan tertulis.
- Nama file `kebab-case.ts`, class `PascalCase`, fungsi/variabel `camelCase`, enum DB `UPPER_SNAKE`.
- Validasi semua input eksternal (request, CSV, respons API pihak ketiga) dengan Zod.

### 4.2 Uang & jumlah aset (wajib)

```ts
// ✅ Benar
const balance: bigint = 1500000000000000000n          // 1.5 ETH dalam wei
const sendable = balance - maxFee
// DB: Decimal(78,0) → konversi ke/dari bigint di repository

// ❌ Salah
const balance = 1.5
const sendable = parseFloat(x) - fee
```

- Konversi tampilan ke desimal hanya dilakukan di lapisan presentasi lewat `fromBaseUnit(value, decimals)`.
- Nilai fiat dihitung dengan decimal library, lalu disimpan bersama `price_source` dan `price_timestamp`.

### 4.3 Logging
- Pakai logger Pino terpusat (`src/lib/logger.ts`), jangan `console.log`.
- Log event dengan nama tetap: `SCAN_STARTED`, `SCAN_COMPLETED`, `TX_BROADCASTED`, dan seterusnya.
- Jangan me-log request body untuk endpoint auth, otorisasi, dan signing.

### 4.4 Error
- Lempar `AppError(code, message, { resourceId })` dengan `code` dari daftar SA bagian 9.
- Error handler global mengubahnya ke format standar dan menyertakan `request_id`.

### 4.5 Git
- Branch: `main` (stabil), `feat/<fase>-<topik>`, `fix/<topik>`.
- Commit memakai [Conventional Commits](https://www.conventionalcommits.org/):
  ```text
  feat(scanner): add EVM native balance reader
  fix(eligibility): handle token-only address without gas
  docs(roadmap): mark phase 2 complete
  test(auth): add role permission matrix
  ```
- Tag di setiap milestone: `v0.1.0-m1`, `v0.2.0-m2`, `v0.3.0-m3`, `v1.0.0`.

## 5. Testing

| Jenis | Lokasi | Jalankan | Catatan |
|-------|--------|----------|---------|
| Unit | `backend/tests/unit`, `shared/tests` | `pnpm test` | Wajib untuk `domain/`, tanpa jaringan |
| Integration (HTTP/DB) | `backend/tests/integration` | `pnpm test` | HTTP lewat `app.inject()`; DB test terpisah mulai Fase 2 |
| Integration (chain) | `backend/tests/integration/chain` | `pnpm test:chain` | Butuh env Sepolia, di-skip jika kosong |
| Frontend | `frontend/src/**/*.test.tsx` | `pnpm --filter frontend test` | Testing Library + jsdom; komponen kritis (Recovery, Signing) |
| E2E | — | Fase 11+ | Manual checklist dulu, Playwright opsional |

Test keamanan yang wajib ada sejak awal:
- Logger me-redact field sensitif.
- Matriks role × endpoint.
- Replay challenge ditolak.
- Signed tx yang dimodifikasi ditolak.
- Pembuat transaksi tidak bisa meng-approve transaksinya sendiri.
- Dump `da_vault` + env server tanpa passphrase tidak bisa mendekripsi key.
- Semua endpoint vault menolak role selain SUPER_ADMIN dan request tanpa MFA/re-auth.
- Signer menolak request tanpa HMAC valid, serta tx yang belum `APPROVED`.
- Grep seluruh output log setelah import/sign/reveal tidak menemukan key atau passphrase.

## 6. Environment variables

Daftar lengkap dan nilai default dev ada di [`.env.example`](../.env.example), yang menjadi sumber kebenarannya. Ringkasan:

```env
APP_ENV=development
NETWORK_MODE=testnet                 # testnet | mainnet — mainnet harus eksplisit
POSTGRES_HOST_PORT=5434              # port host Postgres Docker (5432/5433 dipakai PG native)
DATABASE_URL=postgresql://da:da_dev_only@127.0.0.1:5434/digital_archaeology
REDIS_URL=redis://127.0.0.1:6379

# Auth (Fase 3)
APP_ORIGIN=http://127.0.0.1:5173     # request yang mengubah data dari origin lain ditolak
SESSION_TTL_HOURS=12
SESSION_IDLE_MINUTES=30
COOKIE_SECURE=                       # kosong = true hanya di production
MFA_ENCRYPTION_KEY=                  # wajib: 32 byte acak, base64
SEED_DEV_PASSWORD=                   # password user dev dari seed (≥ 12 karakter)

SEPOLIA_RPC_URL=
EXPLORER_API_KEY=
PRICE_PROVIDER=coingecko
PRICE_API_KEY=
FIAT_CURRENCY=USD
INACTIVITY_THRESHOLD_DAYS=730
FEE_MARGIN_PERCENT=20
CHALLENGE_TTL_MINUTES=15
CONFIRMATIONS_REQUIRED=3
DOCUMENT_ENCRYPTION_KEY=
SIGNER_URL=http://127.0.0.1:4000     # backend → signer (internal); http hanya ke loopback, selain itu https
SIGNER_ALLOW_INSECURE_HTTP=false     # opt-out eksplisit untuk jaringan container privat (warning saat start)
RECOVERY_MIN_NET_VALUE=10            # nilai bersih minimum (FIAT_CURRENCY) agar tidak NOT_ECONOMIC
FEE_MARGIN_PERCENT=20                # margin di atas estimasi fee EIP-1559
ELIGIBILITY_BALANCE_MAX_AGE_HOURS=36 # saldo lebih tua dari ini = STALE_BALANCE
APPROVAL_TTL_MINUTES=30              # approval transaksi berlaku selama ini, lalu EXPIRED
SIGNER_HMAC_SECRET=                  # sama di backend & signer

# --- hanya di env service signer/ ---
VAULT_DATABASE_URL=postgresql://vault:vault@localhost:5432/da_vault
VAULT_UNLOCK_TTL_MINUTES=10
KEY_REVEAL_ENABLED=true              # set false di produksi jika reveal tidak dibutuhkan
```

**Catatan:** tidak ada env untuk passphrase vault, dan memang tidak boleh ada. Passphrase hanya diketik SUPER_ADMIN saat unlock.

`.env` tidak pernah di-commit. `.env.example` hanya berisi nama variabel tanpa nilai rahasia.

## 7. Definition of Done (setiap tugas)

- [ ] Kode + test ditulis, `pnpm test`, `pnpm lint`, dan `pnpm typecheck` hijau
- [ ] Tidak melanggar aturan keras di [CLAUDE.md](../CLAUDE.md)
- [ ] Diff sudah direview (prompt R1 atau `/code-review`)
- [ ] Dokumen diperbarui (prompt D1)
- [ ] Commit dengan pesan yang jelas
