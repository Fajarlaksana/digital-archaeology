# 08 — Uji End-to-End di Sepolia (manual)

Checklist ini dijalankan **manual oleh pemilik projek** dengan wallet testnet sendiri. Hasilnya menutup tiga milestone:

| Milestone | Bukti yang dibutuhkan | Tag |
|-----------|----------------------|-----|
| **M1** (Fase 5) | Saldo & tanggal aktivitas hasil scan **cocok dengan explorer**; scan ulang menghasilkan data identik | `v0.1.0-m1` |
| **M2** (Fase 8) | Daftar address **READY** akurat; setiap `NOT_*` punya alasan jelas | `v0.2.0-m2` |
| **M3** (Fase 11) | **Minimal 3 recovery** end-to-end sukses di testnet dengan audit trail lengkap | `v0.3.0-m3` |

> ⚠️ **Hanya testnet.** Jangan pernah memakai wallet yang pernah/akan menyimpan aset mainnet. Key yang di-import di uji ini dianggap "terbuka".

---

## 0. Persiapan (sekali)

**Yang dibutuhkan**
- [ ] **Wallet sumber** (testnet, punya private key/seed): diisi ETH Sepolia dari faucet (≥ 0,05 ETH). Ini address "lama" yang akan dipulihkan.
- [ ] **Wallet tujuan** di MetaMask (testnet, berbeda dari sumber): untuk bukti kendali destination.
- [ ] Opsional: token ERC-20 Sepolia di wallet sumber (mis. USDC test) untuk menguji jalur token + `NEEDS_GAS_FUNDING`.
- [ ] RPC Sepolia (Alchemy/Infura) dan **API key Etherscan**.

**`.env`** (repository root)
- [ ] `SEPOLIA_RPC_URL=https://…` dan `EXPLORER_API_KEY=…`
- [ ] `SIGNER_HMAC_SECRET` terisi (≥ 32 karakter) — sama untuk backend & signer
- [ ] `APP_DATABASE_URL_READONLY=postgresql://da_signer_ro:…@127.0.0.1:5434/digital_archaeology`
- [ ] `NETWORK_MODE=testnet` (default)

**Infra & aplikasi**
```bash
docker compose up -d
pnpm --filter backend db:deploy
pnpm --filter signer db:deploy
pnpm dev                      # backend :3000, frontend :5173, signer :4000 (loopback)
```
- [ ] Jika volume Postgres sudah ada sebelum Fase 10: buat role `da_signer_ro` (lihat docs/05 "Login read-only signer") lalu `db:deploy` lagi.
- [ ] Live test RPC & explorer lulus: `pnpm --filter backend test -- sepolia.live` (tidak di-skip).

**Akun** — maker-checker menuntut orang berbeda. Untuk uji ini satu orang boleh memegang beberapa akun (email berbeda, authenticator masing-masing), tetapi **di produksi wajib orang yang berbeda**.

| Akun | Role | Dibuat dengan |
|------|------|---------------|
| admin@… | ADMIN | `pnpm --filter backend user:create --email … --name … --role ADMIN` |
| analyst@… | ANALYST | UI **Users** (oleh ADMIN) |
| reviewer@… | REVIEWER | UI **Users** |
| superadmin@… | SUPER_ADMIN | `pnpm --filter backend user:create … --role SUPER_ADMIN` |
| auditor@… | AUDITOR | UI **Users** |

---

## 1. Inventaris & scan (M1)

1. [ ] **ADMIN → Networks**: network Sepolia aktif, `rpc_url_env = SEPOLIA_RPC_URL`, explorer `https://sepolia.etherscan.io`, ETH `priceId = ethereum`. Badge RPC hijau.
2. [ ] **ANALYST → Addresses → Tambah**: address wallet sumber, `owner_reference = SELF`.
3. [ ] **ANALYST → Scans → Mulai scan** Sepolia, tunggu COMPLETED.
4. [ ] Bandingkan dengan explorer: **saldo ETH (base unit)**, **transaksi keluar terakhir**, jumlah tx masuk/keluar, nonce. Catat di tabel di bawah.
5. [ ] Scan ulang → angka identik.

| Cek | Sistem | Explorer | Cocok? |
|-----|--------|----------|--------|
| Saldo (wei) | | | |
| Keluar terakhir | | | |
| Tx keluar / nonce | | | |

➡️ Jika semua cocok: **M1 tercapai** (`git tag v0.1.0-m1`).

## 2. Vault & kepemilikan

6. [ ] **SUPER_ADMIN → Key Vault**: inisialisasi (simpan recovery passphrase offline!), buka, **Import key** wallet sumber.
7. [ ] **ANALYST → Address Detail → Tambah otorisasi** (SELF), lalu **Buat challenge** → tanda tangani (MetaMask dengan akun sumber, atau SUPER_ADMIN lewat Key Vault) → **VERIFIED**.

## 3. Destination & kelayakan (M2)

8. [ ] **ANALYST → Destinations → Tambah**: address wallet tujuan → **Buktikan kendali** dengan MetaMask (akun tujuan) → terverifikasi.
9. [ ] **REVIEWER → Destinations → Approve** (konfirmasi ulang password + kode).
10. [ ] **ANALYST → Recovery → Hitung ulang** → address sumber **READY**. Periksa nilai fee & bersih di Address Detail masuk akal dibanding gas Sepolia saat ini.
11. [ ] Uji alasan `NOT_*` (minimal 2): mis. address kedua tanpa otorisasi → *Kepemilikan belum terverifikasi*; address dengan saldo sangat kecil → *Nilai bersih di bawah minimum*.

➡️ Jika READY akurat dan alasan jelas: **M2 tercapai** (`git tag v0.2.0-m2`).

## 4. Recovery end-to-end (M3) — ulangi 3×

Disarankan: run 1 = **test transfer kecil** (mis. 0,001 ETH), run 2 = test transfer lagi / token, run 3 = **sweep**.

| Langkah | Siapa | Yang dicek |
|---------|-------|-----------|
| 12. **Buat preview** (Address Detail) | ANALYST | Status CREATED; source/destination/amount/fee/nonce benar |
| 13. **Approve** dengan alasan | REVIEWER (≠ ANALYST) | APPROVED, berlaku 30 menit |
| 14. **Sign** (Signing → transaksi) | SUPER_ADMIN (orang ketiga) | Vault terbuka; status SIGNED + tx hash. **DevTools → Network**: body `POST …/sign` = `{}`, response tanpa key/raw tx |
| 15. **Broadcast** → konfirmasi | SUPER_ADMIN | BROADCASTED; tx hash muncul di explorer |
| 16. Tunggu ±1 menit | sistem | PENDING → **CONFIRMED (3/3)**; fee aktual terisi; link explorer benar |
| 17. Address Detail | siapa saja | Recovery = **TRANSFERRED**; saldo diperbarui (sisa debu kecil pada sweep) |
| 18. Explorer | — | from = sumber, to = destination, value = amount, status Success |

| Run | Jenis | Tx hash | Konfirmasi | Fee aktual | OK? |
|-----|-------|---------|-----------|------------|-----|
| 1 | test transfer | | | | |
| 2 | | | | | |
| 3 | sweep | | | | |

➡️ Tiga run sukses + audit trail lengkap (bagian 5): **M3 tercapai** (`git tag v0.3.0-m3`).

## 5. Audit trail (yang harus ada untuk setiap run)

Halaman Audit Logs baru ada di Fase 12; sementara itu jalankan:

```bash
docker compose exec postgres psql -U postgres -d digital_archaeology -c "
SELECT created_at, action, result, resource_type, resource_id, metadata
  FROM audit_logs
 WHERE resource_id = '<transaction-id>' OR metadata->>'txHash' = '<tx-hash>'
 ORDER BY sequence;"
```

Urutan yang diharapkan per transaksi:

1. `TRANSACTION_PREVIEWED` (ANALYST) — berisi nonce, networkFee, unsignedHash
2. `TRANSACTION_APPROVED` (REVIEWER) — alasan, `approvalExpiresAt`
3. `TX_SIGNED` (SUPER_ADMIN) — txHash + unsignedHash, **tanpa** raw tx
4. `TX_BROADCASTED` (SUPER_ADMIN)
5. `TX_CONFIRMED` (sistem, `user_id` kosong) — blockNumber, feePaid

Juga cek:
- [ ] `vault_events` (DB `da_vault`): `UNLOCK`, `KEY_IMPORTED`, `TRANSACTION_SIGNED` (nonce, chainId, txHash) — tanpa isi key.
- [ ] Tidak ada key di log: `grep -ri "<64 hex key tanpa 0x>" <file log backend & signer>` → kosong.
- [ ] Tidak ada raw signed tx di `audit_logs`: `SELECT count(*) FROM audit_logs WHERE metadata::text LIKE '%<awal raw tx>%'` → 0.

## 6. Jika ada masalah

| Gejala | Tindakan |
|--------|----------|
| Preview: `INVALID_NETWORK … does not serve chain` | `SEPOLIA_RPC_URL` menunjuk chain lain |
| Sign: `SIGNER_UNAVAILABLE … APP_DATABASE_URL_READONLY` | Isi env signer, restart `pnpm dev` |
| Broadcast: *fee too low* | Buat preview baru (fee terbaru) |
| Status **STUCK** | Tunggu; jika perlu, speed-up/cancel manual dari wallet sumber dengan nonce yang sama (catat di audit/runbook). Sistem akan menandai FAILED `REPLACED_OR_DROPPED` jika nonce dipakai tx lain |
| `EXPIRED` | Wajar bila nonce/fee/saldo berubah atau approval > 30 menit — buat preview baru |
