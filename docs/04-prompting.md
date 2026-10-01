# 04 — Panduan Prompting (Claude Code)

Dokumen ini berisi **prompt siap-salin** untuk setiap fase di [03-roadmap.md](03-roadmap.md), ditambah prompt utilitas untuk review, debugging, dan dokumentasi.

---

## 1. Alur kerja satu sesi

```text
1. Mulai sesi baru (/clear) untuk setiap fase/tugas besar
2. Aktifkan Plan Mode (Shift+Tab sampai muncul "plan mode")
3. Tempel prompt fase
4. Baca rencana Claude → koreksi jika perlu → setujui
5. Claude menulis kode + test
6. Jalankan sendiri: pnpm test && pnpm lint && pnpm typecheck
7. Review diff (prompt R1 atau /code-review)
8. Minta update dokumen (prompt D1)
9. Commit
```

**Kenapa begini?**
- **/clear per fase** membuat konteks tetap bersih dan fokus. Aturan proyek tetap terbawa lewat [CLAUDE.md](../CLAUDE.md).
- **Plan Mode** memaksa Claude menjelaskan rencana sebelum mengubah file, sehingga kesalahan arah tertangkap lebih awal dan lebih murah diperbaiki.
- **Satu fase = satu commit (atau beberapa commit kecil)** memudahkan rollback.

---

## 2. Anatomi prompt yang baik

```text
[KONTEKS]    Fase berapa, dokumen mana yang relevan
[TUGAS]      Apa yang harus dibuat, spesifik
[BATASAN]    Apa yang TIDAK boleh dilakukan / di luar scope
[KRITERIA]   Kapan dianggap selesai (test apa yang harus lulus)
[OUTPUT]     Format jawaban: rencana dulu, ringkasan di akhir, dll.
```

Template kosong:

```text
Kita di Fase <N> — <nama fase> (docs/03-roadmap.md).
Baca dulu: <daftar file relevan>.

Tugas:
- ...

Batasan:
- Jangan mengerjakan fase lain.
- Ikuti aturan keras di CLAUDE.md.
- ...

Selesai jika:
- ...
- pnpm test, lint, typecheck hijau.

Buat rencana dulu, tunggu persetujuan saya sebelum menulis kode.
```

### Tips

| Lakukan | Hindari |
|---------|---------|
| Sebut file/dokumen yang harus dibaca | "Buatkan aplikasinya" (terlalu luas) |
| Satu fase atau sub-tugas per prompt | Menggabungkan 3 fase sekaligus |
| Sebut kriteria selesai yang bisa dites | "Pastikan bagus" |
| Minta rencana dulu untuk tugas > 3 file | Langsung coding untuk perubahan besar |
| Tempel error **lengkap** saat debugging | "Error, tolong perbaiki" |
| Koreksi dengan spesifik: "ganti X jadi Y karena Z" | Mengulang prompt yang sama tanpa info baru |

---

## 3. Prompt per fase

### P0 — Persiapan (review keputusan)

```text
Baca system_analysis_digital_archaeology.md dan semua file di docs/.
Saya ingin memastikan keputusan di docs/07-decisions.md (ADR-001 s/d ADR-003) sudah tepat.

Konteks saya:
- Wallet lama yang akan diproses kebanyakan di chain: <isi>
- Dipakai untuk: <sendiri / klien dengan mandat>
- Jumlah operator: <isi>
- Pengalaman saya: <misal: kuat di JS, baru di web3>

Beri rekomendasi final untuk tiap ADR beserta alasannya, lalu tunjukkan bagian mana
dari docs/ yang perlu diubah jika rekomendasinya berbeda dari default. Jangan ubah file dulu.
```

### P1 — Fondasi Repository

```text
Kita di Fase 1 — Fondasi Repository (docs/03-roadmap.md).
Baca: CLAUDE.md, docs/05-development-guide.md (struktur folder & konvensi), docs/07-decisions.md.

Tugas: kerjakan semua checklist Fase 1.
- pnpm workspace dengan backend/ dan frontend/ sesuai struktur di 05-development-guide.
- docker-compose.yml untuk PostgreSQL 16 (dua database: digital_archaeology dan da_vault, masing-masing
  dengan user DB berbeda — buat lewat init script) dan Redis.
- Backend: Fastify + TypeScript strict, config env divalidasi Zod (aplikasi gagal start jika env wajib kosong).
- Logger Pino dengan redact untuk: privateKey, seed, mnemonic, passphrase, password, token, secret,
  authorization, cookie. Letakkan logger di modul yang nanti bisa dipakai juga oleh service signer/.
- Endpoint /health, /health/database, /health/rpc (rpc boleh stub).
- Error handler dengan format: code, message, timestamp, request_id, resource_id.
- Frontend: React + Vite + Tailwind, layout sidebar dengan menu dari SA bagian 14 (halaman kosong).
- ESLint + Prettier + Vitest di kedua package, script root: dev, test, lint, typecheck.
- .env.example dan .gitignore.

Batasan:
- Belum ada skema database/Prisma (itu Fase 2).
- Jangan install library blockchain dulu.
- Belum membuat package signer/ (itu Fase 7), tapi siapkan pnpm-workspace agar bisa ditambah nanti.

Selesai jika:
- docker compose up -d && pnpm dev berjalan, GET /health = 200.
- Ada test bahwa logger menyensor field sensitif.
- pnpm test, pnpm lint, pnpm typecheck hijau.
- Bagian "Perintah" di CLAUDE.md diperbarui sesuai script yang benar-benar ada.

Buat rencana dulu.
```

### P2 — Database & Domain Model

```text
Kita di Fase 2 — Database & Domain Model.
Baca: system_analysis_digital_archaeology.md bagian 5, docs/02-project-analysis.md bagian 2.2 dan 2.3.

Tugas:
- Setup Prisma di backend dengan PostgreSQL.
- Buat schema untuk semua tabel di checklist Fase 2, memakai revisi dari 02-analysis
  (status dipecah per dimensi, tabel tambahan, kolom tambahan).
- Semua jumlah aset: Decimal @db.Decimal(78,0) dalam base unit. Tidak boleh Float.
- addresses.owner_reference NOT NULL, unique (network_id, address).
- Seed: network Sepolia (chainId 11155111), aset ETH, 1 token ERC-20 testnet, user admin dev
  (password dari env, bukan hardcode).
- Helper toBaseUnit/fromBaseUnit berbasis bigint + unit test (0, 1 wei, 18 desimal, angka sangat besar, input invalid).
- Repository layer per entitas. AuditLogRepository hanya punya create & read.

Batasan: tabel vault (vault_config, vault_keys, vault_events) TIDAK masuk schema ini —
itu schema terpisah milik service signer/ di Fase 7. Schema aplikasi tidak boleh punya kolom
untuk private key, seed, atau passphrase dalam bentuk apa pun.

Sebelum menulis schema, tunjukkan ERD ringkas (teks) dan daftar enum untuk saya setujui.
```

### P3 — Autentikasi & RBAC

```text
Kita di Fase 3 — Autentikasi & RBAC.
Baca: SA bagian 8, docs/03-roadmap.md Fase 3.

Tugas: kerjakan checklist Fase 3.
- argon2 untuk password, session di httpOnly + secure + sameSite cookie, timeout dapat dikonfigurasi.
- Role: SUPER_ADMIN, ADMIN, ANALYST, REVIEWER, AUDITOR (SIGNER dari SA dilebur ke SUPER_ADMIN, lihat ADR-003).
- Tidak ada self-register; ADMIN membuat user dan menetapkan role, KECUALI SUPER_ADMIN:
  akun SUPER_ADMIN hanya bisa dibuat lewat skrip CLI di server (create-super-admin), tidak lewat UI/API.
- MFA TOTP wajib untuk SUPER_ADMIN dan REVIEWER (setup saat login pertama).
- Permission map terpusat (satu file) sesuai SA 8.2 + permission vault:* khusus SUPER_ADMIN;
  middleware requirePermission(permission) dan requireRecentAuth(maxAgeMinutes) untuk aksi sensitif.
- Rate limit login (misal 5 percobaan / 15 menit / IP+username).
- Audit log otomatis: login sukses/gagal + setiap request POST/PATCH/DELETE (tanpa body sensitif).
- Frontend: halaman login, guard route berdasarkan role, halaman manajemen user (ADMIN).

Selesai jika: ada test matriks role × endpoint (termasuk ADMIN biasa ditolak di permission vault:*),
test MFA wajib, dan test bahwa password tidak muncul di log maupun di response.
Rencana dulu.
```

### P4 — Network & Address Inventory

```text
Kita di Fase 4 — Network & Address Inventory.

Tugas: kerjakan checklist Fase 4.
- Validasi address lewat ChainAdapter.validateAddress (buat interface-nya sekarang; implementasi EVM cukup
  validasi format + checksum memakai viem.isAddress / getAddress).
- Import CSV kolom: address, network, label, owner_reference. Kembalikan ringkasan:
  jumlah diterima, ditolak, beserta alasan per baris (invalid format, duplikat, owner_reference kosong, network tidak dikenal).
- Simpan address dalam bentuk checksum.
- Halaman Networks, Addresses (tabel, filter per network & status, pagination), Address Detail (kerangka).

Batasan: belum ada pembacaan saldo/aktivitas (Fase 5).
Selesai jika: test import CSV berisi campuran baris valid/invalid lulus.
```

### P5 — Scanner & Activity Analyzer (bisa dipecah 3 sesi)

**P5a — Adapter & provider**

```text
Kita di Fase 5a — ChainAdapter EVM.
Baca: docs/02-project-analysis.md bagian 2.1 dan 3.

Tugas:
- Lengkapi interface ChainAdapter, BalanceProvider, ActivityProvider (bagian baca saja:
  validateAddress, getNativeBalance, getTokenBalance, getActivity).
- Implementasi EVM pakai viem (RPC dari env) untuk saldo native, ERC-20 balanceOf, dan nonce.
- ActivityProvider via Etherscan-compatible API (key dari env): last_incoming_at, last_outgoing_at,
  jumlah tx masuk/keluar. Tangani pagination & rate limit.
- Retry dengan exponential backoff, timeout, dan error code sesuai SA bagian 9.
- Unit test dengan mock HTTP/RPC; integration test terhadap Sepolia ditandai terpisah (skip jika env kosong).

Batasan: method tulis (build tx, broadcast) belum dibuat.
```

**P5b — Analyzer & job**

```text
Kita di Fase 5b — Activity Analyzer & Scan Job.

Tugas:
- Analyzer murni (pure function): input data aktivitas + threshold + tanggal scan → inactive_days, activity_status, balance_status.
- Cross-check: nonce RPC vs jumlah tx keluar indexer berbeda → review_flag = true + catatan.
- BullMQ job SCAN_AUTHORIZED_ADDRESSES: buat record scans, proses address per batch,
  simpan scan_results (histori), update status di addresses, catat error per address tanpa menghentikan scan.
- Rate limit per provider (konfigurasi).
- Endpoint: POST /api/scans, GET /api/scans, GET /api/scans/:id, GET /api/addresses/:id/activity.

Selesai jika: unit test analyzer mencakup batas threshold (tepat di hari threshold, sehari sebelum/sesudah),
address tanpa transaksi sama sekali, dan address yang hanya punya transaksi masuk.
```

**P5c — UI Scan**

```text
Kita di Fase 5c — Halaman Scans.
Tugas: halaman untuk membuat scan (pilih network, threshold, min/max saldo), melihat progres (polling),
dan hasil per address dengan status. Address Detail menampilkan aktivitas terakhir.
Setelah selesai, jalankan scan terhadap wallet testnet saya dan bandingkan hasilnya dengan explorer
(beri saya langkah verifikasi manual).
```

### P6 — Valuasi & Dashboard

```text
Kita di Fase 6 — Valuasi & Dashboard Read-only.

Tugas: kerjakan checklist Fase 6.
- PriceProvider (CoinGecko, key opsional dari env) + cache TTL + simpan price_snapshots.
- fiat_value dihitung dengan decimal library (decimal.js atau sejenis), tidak memakai Number untuk uang.
- Scheduler: UPDATE_PRICE, REFRESH_BALANCES, REFRESH_ACTIVITY (cron dari konfigurasi).
- Dashboard cards sesuai SA bagian 14, riwayat aktivitas, status job.
- Export CSV: Address Inventory & Inactivity Report. Setiap nilai fiat disertai sumber & timestamp harga.

Selesai jika: dashboard menampilkan angka yang cocok dengan query DB, dan unit test valuasi lulus.
Setelah selesai, buat checklist uji manual Milestone M1 untuk saya jalankan.
```

### P7 — Key Vault & Ownership Verification (pecah 4 sesi)

Ini fase paling sensitif di seluruh projek. Kerjakan per sub-fase dan review setiap diff dengan teliti.

**P7a — Fondasi service signer & kriptografi vault**

```text
Kita di Fase 7a — Key Vault: fondasi service signer/.
Baca: CLAUDE.md (aturan keras 2–4), docs/07-decisions.md ADR-003, ADR-008, ADR-009,
docs/02-project-analysis.md bagian 2.3 (tabel vault) dan 2.5.

Tugas:
- Package signer/ di monorepo: Fastify internal, bind ke host internal saja (bukan 0.0.0.0 di produksi),
  setiap request dari backend wajib ditandatangani HMAC (shared secret dari env) + timestamp anti-replay.
- Prisma schema terpisah untuk DB da_vault: vault_config, vault_keys, vault_events.
- Modul crypto murni (dengan unit test):
  - deriveKek(passphrase, salt, params) → Argon2id
  - wrap/unwrap master key → AES-256-GCM (iv acak 12 byte, simpan auth tag)
  - encryptKey/decryptKey dengan master key
- Inisialisasi vault: passphrase utama + recovery passphrase → MK acak 32 byte → simpan wrapped_mk dan wrapped_mk_recovery.
  Inisialisasi hanya boleh sekali (tolak jika sudah ada).
- Unlock/lock: MK di memori dengan TTL (VAULT_UNLOCK_TTL_MINUTES), auto-lock via timer, lock endpoint,
  MK hilang saat restart. Passphrase tidak pernah disimpan atau di-log.

Batasan: belum ada import key, signing, atau UI (sesi berikutnya).
Test wajib: round-trip enkripsi; passphrase salah → gagal tanpa membocorkan info;
data vault + env tanpa passphrase tidak bisa didekripsi; auto-lock setelah TTL; request tanpa HMAC valid → 401.
Rencana dulu.
```

**P7b — Import key, reveal, dan halaman Key Vault**

```text
Kita di Fase 7b — Key Vault: import, reveal, UI.

Tugas:
- Endpoint backend (permission vault:*, hanya SUPER_ADMIN, wajib requireRecentAuth + MFA) yang meneruskan ke signer:
  init, unlock, lock, status, import, reveal, change-passphrase, recover-with-recovery-passphrase.
- Import: terima privkey hex ATAU seed + derivation path; derive address dengan viem;
  tolak jika address tidak ada di inventory atau owner_reference kosong; simpan terenkripsi.
- Reveal sesuai ADR-009: re-auth password + MFA + passphrase, rate limit 3/jam, Cache-Control: no-store,
  respons tidak di-log, audit log KEY_REVEALED tanpa isi key, nonaktif jika KEY_REVEAL_ENABLED=false.
- Pastikan body request import/unlock/reveal tidak pernah masuk log backend maupun signer.
- Frontend halaman Key Vault (hanya tampil untuk SUPER_ADMIN): status lock + sisa waktu,
  daftar address yang punya key (tanpa isi key), form import, modal reveal (tersamar default,
  tombol tampilkan, auto-tutup 60 detik, bersihkan state saat tutup).

Test wajib: role lain → 403 di semua endpoint vault; import key untuk address yang tidak cocok → ditolak;
reveal saat flag off → ditolak; grep log setelah import & reveal tidak menemukan key.
```

**P7c — Ownership Verification**

```text
Kita di Fase 7c — Ownership Verification.
Baca: SA bagian 4.5, docs/02-project-analysis.md bagian 2.4.

Tugas:
- Challenge dengan format persis seperti 02-analysis bagian 2.4; nonce crypto.randomBytes(32), expiry default 15 menit.
- Dua jalur tanda tangan:
  a) address yang key-nya ada di vault → SUPER_ADMIN klik "Verify with Vault" (vault harus unlocked),
     signer menandatangani pesan challenge persis seperti yang tersimpan.
  b) address yang key-nya tidak di vault → connect wallet (wagmi, personal_sign) atau paste signature.
- Verifikasi pakai viem verifyMessage; tandai used_at pada pemakaian pertama (sukses ataupun gagal).
- Dokumen otorisasi: simpan metadata + SHA-256 hash. File terenkripsi di storage lokal (kunci dari env)
  atau cukup referensi eksternal — tunjukkan opsinya dulu.

Test wajib: signature valid → VERIFIED; signature dari address lain → REJECTED;
challenge kedaluwarsa → EXPIRED; challenge dipakai ulang → ditolak; jalur vault saat vault locked → ditolak.
```

**P7d — Review keamanan vault**

```text
Lakukan review keamanan menyeluruh pada service signer/ dan semua endpoint vault di backend.
Cek: jalur mana saja yang bisa membuat key/passphrase/MK keluar dari memori signer
(log, error, stack trace, response, crash dump, variabel global, cache), apakah TTL benar-benar
menghapus MK, apakah permission & MFA ditegakkan di SEMUA endpoint vault, dan apakah signer bisa
diakses tanpa HMAC. Urutkan temuan dari paling serius. Jangan ubah file dulu.
```

Setelah P7d, jalankan juga `/security-review`.

### P8 — Destination & Eligibility

```text
Kita di Fase 8 — Destination Whitelist & Eligibility Engine.
Baca: SA bagian 4.7, docs/02-project-analysis.md bagian 2.6 dan 2.7.

Tugas: kerjakan checklist Fase 8.
- destinations harus di-approve oleh REVIEWER yang bukan pembuatnya.
- estimateTransferFee di adapter EVM (EIP-1559: maxFeePerGas, maxPriorityFeePerGas, gasLimit) + margin dari konfigurasi.
- Eligibility engine sebagai pure function; semua perhitungan dalam bigint base unit.
  Output: recovery_status + reason code (NOT_VERIFIED, NO_KEY_IN_VAULT, NO_DESTINATION, NOT_ECONOMIC,
  NEEDS_GAS_FUNDING, READY). Status key diambil dari endpoint status signer (ada/tidak, tanpa isi key).
- Eligibility report CSV.

Test wajib: setiap cabang aturan + kasus token tanpa saldo native.
```

### P9 — Preview & Approval

```text
Kita di Fase 9 — Transaction Preview & Approval.
Baca: SA bagian 4.8, docs/02-project-analysis.md bagian 2.5 dan 2.7.

Tugas: kerjakan checklist Fase 9.
- buildUnsignedTransfer di adapter EVM: sweep native (balance - fee max) atau transfer ERC-20.
  Ambil nonce dan fee terbaru saat preview.
- Simpan unsigned_payload (JSON kanonik) + unsigned_hash.
- Approval: REVIEWER ≠ created_by, alasan wajib, kedaluwarsa jika fee naik > toleransi atau saldo berubah.
- Halaman Recovery menampilkan Source/Destination/Asset/Amount/Fee/Network dengan jelas,
  termasuk peringatan jika destination baru pertama kali dipakai.

Batasan: belum ada signing.
Test wajib: pembuat tidak bisa approve; approval basi ditolak.
```

### P10 — Transaction Signing via Key Vault

```text
Kita di Fase 10 — Transaction Signing via Key Vault.
Baca: docs/02-project-analysis.md bagian 2.5 (alur signing), docs/07-decisions.md ADR-003 & ADR-008.

Tugas: kerjakan checklist Fase 10.
- Halaman Signing (hanya SUPER_ADMIN): daftar tx APPROVED dengan detail lengkap, tombol Sign.
  Wajib vault unlocked; minta ulang MFA jika auth terakhir > 5 menit.
- POST /api/transactions/:id/sign: client hanya mengirim id. Backend mengirim transaction_id ke signer (HMAC).
- Di signer: ambil unsigned_payload yang di-approve, verifikasi ulang status APPROVED, approver ≠ created_by,
  approval belum kedaluwarsa, unsigned_hash cocok. Dekripsi key di memori → viem signTransaction →
  hapus referensi key → kembalikan signed raw tx saja.
- Signed Tx Verifier di backend: parse, recover sender, bandingkan dengan unsigned_payload
  (from, to, value, data, nonce, chainId, gasLimit, maxFeePerGas ≤ cap). Ada beda → tolak + audit log.
- Status SIGNED + audit log TX_SIGNED (tanpa isi key, tanpa signed raw tx di log).

Batasan keras:
- Client tidak boleh bisa mengirim payload tx untuk di-sign; signer hanya menandatangani data yang sudah di-approve.
- Tidak ada broadcast di fase ini.

Test wajib: tx belum APPROVED → ditolak; approver = pembuat → ditolak; approval kedaluwarsa → ditolak;
vault locked → ditolak; payload di DB diubah setelah approve (hash tidak cocok) → ditolak;
user non-SUPER_ADMIN → 403.
Setelah selesai, jelaskan cara saya memverifikasi lewat DevTools bahwa tidak ada key yang terkirim saat signing.
```

### P11 — Broadcast & E2E

```text
Kita di Fase 11 — Broadcast & Confirmation.

Tugas: kerjakan checklist Fase 11.
- broadcast via adapter (eth_sendRawTransaction), simpan tx_hash, status BROADCASTED → PENDING.
- Job CHECK_PENDING_TRANSACTIONS: konfirmasi (konfigurasi jumlah blok), CONFIRMED / FAILED + failure_reason.
- Setelah CONFIRMED: recovery_status = TRANSFERRED, trigger refresh saldo.
- Halaman Transactions + link explorer.

Lalu buat skrip/checklist uji end-to-end di Sepolia yang saya jalankan manual dengan wallet testnet saya,
dari import sampai confirmed, dan daftar apa yang harus dicek di audit log.
```

### P12 – P14

```text
Kita di Fase <12|13|14> — <nama>. Kerjakan checklist fase tersebut di docs/03-roadmap.md.
Rencana dulu, lalu kerjakan per sub-tugas dan laporkan setelah tiap sub-tugas selesai.
```

Khusus Fase 13, jalankan juga `/security-review` dan `/code-review high` lalu minta Claude memperbaiki temuannya satu per satu.

---

## 4. Prompt utilitas

### R1 — Review diff sebelum commit

```text
Review semua perubahan yang belum di-commit. Fokus:
1) bug & edge case, 2) pelanggaran aturan keras di CLAUDE.md,
3) jumlah aset yang memakai float/Number, 4) data sensitif yang mungkin ter-log,
5) test yang kurang. Urutkan dari yang paling serius. Jangan ubah file dulu.
```

(Alternatif bawaan: `/code-review`)

### B1 — Debugging

```text
Error berikut muncul saat <langkah yang dilakukan>:

<tempel error/stack trace lengkap>

Yang sudah saya coba: <...>
Cari akar masalahnya dulu dan jelaskan sebelum memperbaiki. Jangan menambal gejala.
```

### T1 — Menambah test

```text
Tambahkan test untuk <modul/file>. Cakup jalur normal, batas (boundary), input invalid,
dan kegagalan dependency (RPC timeout, DB error). Jangan ubah kode produksi kecuali ada bug —
jika ada bug, laporkan dulu.
```

### D1 — Update dokumentasi setelah fase selesai

```text
Fase <N> selesai. Perbarui:
- docs/03-roadmap.md: centang checklist yang benar-benar selesai, tambah baris di Log progres.
- docs/06-manual-guide.md: bagian fitur yang sekarang bisa dipakai user (langkah klik demi klik).
- docs/07-decisions.md: catat keputusan teknis baru yang diambil di fase ini.
- CLAUDE.md: hanya jika ada perintah/konvensi baru.
- README.md: baris Status.
Tunjukkan ringkasan perubahannya.
```

### E1 — Memahami kode

```text
Jelaskan bagaimana <fitur/alur> bekerja di codebase ini, dari request masuk sampai data tersimpan.
Sebutkan file dan fungsi yang terlibat. Saya ingin bisa memodifikasinya sendiri.
```

### C1 — Commit

```text
Buat commit untuk perubahan ini dengan format Conventional Commits (lihat docs/05-development-guide.md).
Pecah jadi beberapa commit jika perubahannya mencakup hal yang berbeda.
```

---

## 5. Saat Claude melenceng

| Gejala | Respons |
|--------|---------|
| Mengerjakan di luar fase | "Stop. Kembalikan perubahan di luar Fase N. Fokus hanya pada checklist Fase N." |
| Memakai float untuk jumlah | "Aturan keras #6 di CLAUDE.md: ganti ke bigint/Decimal base unit dan tambahkan test." |
| Test dilewati / di-skip agar hijau | "Jangan skip atau melemahkan test. Perbaiki kodenya, atau jelaskan kenapa test-nya salah." |
| Rencana terlalu besar | "Pecah menjadi sub-tugas yang masing-masing bisa di-commit sendiri. Kerjakan yang pertama saja." |
| Konteks sudah panjang dan jawaban mulai kacau | Jalankan D1, commit, lalu `/clear` dan lanjutkan dengan prompt baru |
