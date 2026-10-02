# 06 — Manual Guide (Panduan Pengguna & Operator)

> **Status: DRAFT.** Isi dokumen ini sesuai rancangan. Setiap bagian ditandai fase yang membangunnya, dan setelah fase tersebut selesai, langkah-langkahnya diperbarui agar sesuai dengan aplikasi yang sebenarnya (prompt D1 di [04-prompting.md](04-prompting.md)).

---

## 1. Sebelum memakai sistem

Sistem ini hanya boleh dipakai untuk address yang:
- milik Anda sendiri, **atau**
- punya mandat/kontrak/otorisasi tertulis yang sah dari pemiliknya.

Address yang lama tidak aktif **bukan** berarti tidak ada pemiliknya. Semua aktivitas Anda di sistem tercatat di audit log.

## 2. Peran (role)

| Role | Bisa | Tidak bisa |
|------|------|-----------|
| **SUPER_ADMIN** | Satu-satunya yang bisa mengakses **Key Vault**: inisialisasi, unlock/lock, import key, reveal key, menandatangani transaksi APPROVED, broadcast | Menandatangani transaksi yang belum di-approve REVIEWER |
| **ADMIN** | Kelola user (kecuali SUPER_ADMIN), network, aset, dan konfigurasi | Mengakses Key Vault, meng-approve transaksi miliknya sendiri |
| **ANALYST** | Import address, menjalankan scan, melihat dan export laporan, membuat preview transaksi | Approve, sign |
| **REVIEWER** | Review otorisasi, approve destination & transaksi | Approve sesuatu yang ia buat sendiri |
| **AUDITOR** | Membaca audit log & laporan | Mengubah data apa pun |

Satu orang boleh punya beberapa role, tetapi **pembuat transaksi tidak bisa menjadi approver-nya**. Akun SUPER_ADMIN hanya bisa dibuat lewat server (CLI), tidak lewat menu aplikasi. **MFA wajib untuk SUPER_ADMIN, ADMIN, dan REVIEWER.** Menu yang tampil di sidebar mengikuti role Anda.

## 3. Login & MFA · *Fase 3* ✅

### 3.1 Login biasa
1. Buka aplikasi (dev: `http://127.0.0.1:5173`), lalu masukkan email dan password dari ADMIN.
2. Jika salah, pesan yang muncul selalu sama ("Invalid email or password"), termasuk untuk akun yang terkunci. Ini disengaja agar penyerang tidak bisa menebak akun.
3. Setelah 5 kali salah dalam 15 menit, login ditahan sementara. Setelah 10 kali salah berturut-turut, **akun terkunci** dan hanya ADMIN yang bisa membukanya.
4. Sesi berakhir setelah **30 menit tanpa aktivitas**, atau paling lama **12 jam**. Klik **Keluar** di pojok kiri bawah untuk mengakhiri sesi.

### 3.2 Login pertama untuk SUPER_ADMIN / ADMIN / REVIEWER (setup MFA)
1. Setelah password diterima, muncul halaman **Aktifkan verifikasi dua langkah**. Klik **Mulai setup**.
2. Pindai QR dengan aplikasi authenticator (Google Authenticator, Aegis, 1Password, dll.). Jika tidak bisa dipindai, ketik kunci yang ditampilkan.
3. Masukkan kode 6 digit dari aplikasi, lalu klik **Aktifkan MFA**.
4. Lakukan langkah ini **segera** setelah menerima password awal.

### 3.3 Login berikutnya (dengan MFA)
1. Masukkan email dan password, lalu kode 6 digit dari aplikasi authenticator.
2. Satu kode hanya bisa dipakai sekali. Setelah 5 kode salah, sesi dibatalkan dan Anda harus login ulang.

### 3.4 Membuat akun SUPER_ADMIN (di server, oleh pengelola sistem)
```bash
pnpm --filter backend user:create --email nama@domain --name "Nama" --role SUPER_ADMIN
```
Password diketik tanpa ditampilkan dan diminta dua kali. Pembuatan akun ini tercatat di audit log (`USER_CREATED_CLI`). Setup MFA dilakukan saat login pertama.

## 3A. Manajemen user · *Fase 3* ✅ · ADMIN (lihat: AUDITOR)

1. Menu **Users** menampilkan semua akun beserta role, status, status MFA, dan login terakhir.
2. **Tambah user**: isi email, nama, password awal (minimal 12 karakter), lalu pilih role. Role SUPER_ADMIN tidak tersedia di sini.
3. **Ubah role / Nonaktifkan / Buka kunci**: tersedia per baris. Setiap perubahan role atau status langsung **mengeluarkan user tersebut dari semua sesinya**.
4. Anda tidak bisa mengubah role atau status akun Anda sendiri, dan tidak bisa mengubah akun SUPER_ADMIN.
5. Semua perubahan tercatat di audit log beserta data sebelum dan sesudahnya.

## 4. Networks & aset · *Fase 4* ✅ · ADMIN (lihat: semua role)

1. Menu **Networks** menampilkan setiap network beserta aset yang dipantau, status testnet/mainnet, dan apakah RPC sudah dikonfigurasi di server.
2. **Tambah network**: isi nama slug (`holesky`), nama tampilan, chain ID, **nama env var RPC** (misalnya `HOLESKY_RPC_URL`, **bukan** URL-nya), URL explorer, serta aset native (simbol, nama, desimal).
   - URL RPC disimpan di file `.env` server oleh pengelola sistem, karena biasanya berisi API key.
   - Dari UI hanya network **testnet** yang bisa ditambahkan. Network mainnet ditolak selama server berjalan dengan `NETWORK_MODE=testnet`.
3. **Tambah token ERC-20** (di kartu network): alamat kontrak, simbol, nama, dan desimal (0–36). Alamat kontrak diperiksa checksum-nya.
4. **Nonaktifkan** network: address di network itu tidak bisa ditambah atau di-import (data lama tetap ada). Chain ID dan status testnet tidak bisa diubah setelah dibuat.

## 5. Mendaftarkan address · *Fase 4* ✅ · ANALYST (lihat: semua role)

### 5.1 Tambah satu address
Menu **Addresses**, lalu **Tambah address**. Pilih network, lalu isi address, label (opsional), dan **owner reference** (wajib, misalnya `SELF`, nomor kontrak, atau ID kasus).

Aturan address EVM:
- Address huruf kecil semua diterima dan disimpan dalam bentuk checksum (huruf besar-kecil campuran).
- Address yang huruf besar-kecilnya **tidak cocok** dengan checksum ditolak, karena hampir pasti salah ketik. Salin ulang dari sumbernya.
- Zero address (`0x000…000`) ditolak.

### 5.2 Import CSV (preview dulu)
1. Menu **Addresses**, lalu **Import CSV**. Unduh template jika perlu.
2. Format file (maksimal 5.000 baris, 2 MB; kolom `label` opsional; header tidak peka huruf besar):
   ```csv
   address,network,label,owner_reference
   0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed,sepolia,Wallet lama 2019,SELF
   0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359,sepolia,Klien A,CASE-2026-001
   ```
3. Pilih file, lalu klik **Periksa**. Sistem menampilkan jumlah baris valid dan ditolak, ringkasan per alasan, serta tabel baris yang ditolak (nomor baris + alasan). **Belum ada yang disimpan.**
4. Jika sudah sesuai, klik **Simpan N baris valid**. Baris yang ditolak tidak disimpan; perbaiki di file lalu import ulang.

| Alasan ditolak | Artinya |
|----------------|---------|
| Format address salah | Bukan `0x` + 40 karakter hex |
| Checksum salah | Huruf besar/kecil tidak cocok, kemungkinan salah ketik |
| Network tidak dikenal / nonaktif | Nama di kolom `network` tidak ada di menu Networks, atau network-nya nonaktif |
| owner_reference kosong | Wajib diisi |
| Duplikat di file | Address yang sama muncul lebih dari sekali di file |
| Sudah terdaftar | Address sudah ada di sistem (termasuk yang diarsipkan) |

### 5.3 Detail, ubah, dan arsip
- Klik address di tabel untuk membuka **detail**: status aktivitas, saldo, otorisasi, recovery, owner reference, dan link ke explorer.
- **Ubah** label atau owner reference. Setiap perubahan tercatat dengan nilai sebelum dan sesudah.
- **Arsipkan** address yang tidak dipakai lagi. Address hilang dari daftar dan tidak ikut di-scan, tetapi riwayatnya tetap ada. Lihat lewat filter **Tampilkan → Diarsipkan**, lalu **Pulihkan dari arsip** bila perlu. Address yang diarsipkan tidak bisa diubah sebelum dipulihkan.

## 6. Menjalankan scan · *Fase 5* ✅ · ANALYST (lihat: semua role)

### 6.1 Prasyarat (pengelola server)
Isi di `.env` server, lalu restart backend:
- `SEPOLIA_RPC_URL`: URL RPC Sepolia dari Alchemy/Infura. Nama variabel ini harus sama dengan "Env var RPC" di menu Networks.
- `EXPLORER_API_KEY`: API key Etherscan (berlaku juga untuk Sepolia).

Cek di `http://127.0.0.1:3000/health/rpc`: status `ok` berarti siap. Jika belum dikonfigurasi, tombol **Mulai scan** menampilkan pesan yang menyebut variabel mana yang kurang.

### 6.2 Membuat scan
1. Menu **Scans**, isi form **Scan baru**:
   - **Network.**
   - **Tidak aktif ≥ (hari)**, default 730 = 2 tahun.
   - **Saldo minimum/maksimum** (opsional, dalam satuan aset native, misalnya `0.01`). Rentang ini hanya untuk menandai hasil "sesuai kriteria"; semua address tetap di-scan.
2. Klik **Mulai scan**. Halaman detail terbuka dan progres diperbarui otomatis. Halaman boleh ditinggal karena scan berjalan di server.
3. Hanya satu scan per network yang bisa berjalan pada satu waktu. Address yang **diarsipkan** tidak ikut di-scan.

### 6.3 Cara sistem menilai "tidak aktif"
- Dihitung dari **transaksi keluar terakhir**, yaitu transaksi yang hanya bisa dibuat pemegang private key.
- Token atau ETH yang **masuk** (termasuk airdrop spam) **tidak** membuat wallet dianggap aktif.
- Address yang belum pernah mengirim apa pun dihitung sejak aktivitas pertamanya.
- Address tanpa riwayat sama sekali berstatus **INACTIVE** dengan "hari tidak aktif" kosong.

### 6.4 Membaca hasil
Tab di halaman detail scan: **Semua**, **Tidak aktif**, **Sesuai kriteria** (tidak aktif + saldo native dalam rentang), **Perlu review**, **Gagal**.

| Tanda | Arti | Tindakan |
|-------|------|----------|
| INACTIVE / ACTIVE | Lewat / belum lewat threshold sejak transaksi keluar terakhir | — |
| perlu review: `NONCE_MISMATCH` | Jumlah transaksi keluar menurut node (nonce) ≠ menurut explorer | Cek manual di explorer; bisa juga smart-contract wallet |
| perlu review: `HISTORY_TRUNCATED` | Riwayat > 10.000 transaksi, sehingga hitungan tidak lengkap | Cek manual |
| perlu review: `BALANCE_WITHOUT_HISTORY` | Ada saldo tetapi tidak ada transaksi (misalnya withdrawal validator) | Cek manual |
| Gagal: `RPC_TIMEOUT` / `RPC_RATE_LIMIT` / ... | Address gagal dibaca; data lamanya tidak berubah | Jalankan scan ulang nanti |

Detail address menampilkan **saldo per aset** (angka persis, tanpa pembulatan) dan **riwayat scan** (jumlah tx masuk/keluar, nonce, tanggal masuk/keluar terakhir).

Scan terjadwal otomatis menyusul di Fase 6.

## 7. Dashboard, nilai & laporan · *Fase 6* ✅ · semua role

### 7.1 Dashboard
Halaman awal setelah login menampilkan:
- **Address terdaftar / Tidak aktif / Terverifikasi / Transaksi.** Address yang diarsipkan tidak dihitung.
- **Estimasi nilai address tidak aktif** dan **estimasi nilai seluruh inventaris**, dalam USD.
- **Scan per network**: scan terakhir (manual atau *terjadwal*) dan jadwal scan otomatis berikutnya.
- **Status sistem**: backend, database, RPC.

### 7.2 Cara membaca nilai
- Nilai fiat adalah **estimasi** dari harga CoinGecko, **bukan** dasar kepemilikan. Waktu dan sumber harga selalu ditampilkan.
- Aset **testnet** (misalnya Sepolia ETH) tidak punya harga pasar. Sistem menghargainya seperti aset mainnet padanannya **hanya untuk simulasi**, dengan label kuning **SIMULASI**. Angka ini tidak bernilai nyata dan dipisahkan dari nilai nyata di dashboard.
- Harga diperbarui otomatis setiap 60 menit. Saldo hasil scan baru langsung dinilai dengan harga terakhir.

### 7.3 Mengatur harga · ADMIN
- Menu **Networks**, lalu kolom **ID harga (CoinGecko)** di setiap aset: klik **ubah** dan isi ID CoinGecko, misalnya `ethereum`, `usd-coin`, `chainlink`. ID bisa dicari di coingecko.com (bagian "API ID" di halaman koin). Kosongkan untuk berhenti menilai aset itu.
- **Perbarui harga sekarang** mengambil harga tanpa menunggu jadwal, lalu menampilkan jumlah aset yang berhasil dihargai dan ID yang tidak ditemukan.

### 7.4 Scan otomatis
- Setiap network aktif yang sudah dikonfigurasi dan punya address di-scan otomatis **setiap hari pukul 02:00 WIB** (atur di `.env`: `SCAN_SCHEDULE_CRON`, `SCHEDULER_TIMEZONE`; `off` untuk mematikan).
- Scan otomatis tercatat sebagai aksi **SYSTEM** dan diberi label *terjadwal*. Scan ini **hanya membaca** blockchain dan tidak pernah memindahkan aset.

### 7.5 Export CSV
- Menu **Addresses**, lalu **Export inventaris (CSV)** atau **Export tidak aktif (CSV)**. Satu baris per address × aset, berisi saldo persis (desimal + base unit), estimasi nilai, `value_simulated`, sumber dan waktu harga, serta status.
- Isian yang diawali `=`, `+`, `-`, `@` diberi tanda kutip satu (`'`) agar tidak dijalankan sebagai rumus saat dibuka di Excel/Sheets.
- Setiap export tercatat di audit log.

## 8. Key Vault · *Fase 7* ✅ · SUPER_ADMIN

Key Vault menyimpan private key dalam keadaan terenkripsi di **service signer terpisah**. Hanya SUPER_ADMIN yang melihat menu ini. Passphrase vault **tidak pernah disimpan** di mana pun.

> **Konfirmasi ulang:** semua aksi vault kecuali **Kunci** meminta konfirmasi identitas (password akun + kode authenticator) jika konfirmasi terakhir lebih dari **5 menit** lalu. Form konfirmasi muncul otomatis, lalu aksi dilanjutkan.

### 8.1 Inisialisasi (sekali saja)
1. Menu **Key Vault**, lalu form **Inisialisasi vault**.
2. **Passphrase utama:** minimal 16 karakter. Disarankan 4–5 kata acak, dan **berbeda** dari password login.
3. **Recovery passphrase:** harus berbeda dari passphrase utama. **Tulis di kertas** dan simpan di tempat fisik yang aman (brankas). Jangan simpan di HP, cloud, chat, atau foto.
4. Centang pernyataan bahwa recovery passphrase sudah disimpan, lalu klik **Inisialisasi**.
5. ⚠ Jika **kedua** passphrase hilang, semua key di vault **tidak bisa dibuka selamanya**. Tidak ada "lupa password".
6. Setelah inisialisasi, vault dalam keadaan **terkunci**.

### 8.2 Buka & kunci
1. Isi **Passphrase vault**, lalu klik **Buka**. Status berubah menjadi **TERBUKA** dengan hitung mundur.
2. Vault terkunci otomatis setelah **10 menit**, saat Anda **logout**, atau saat service signer di-restart. Klik **Kunci vault sekarang** jika sudah selesai.
3. Setelah 5 passphrase salah dalam 15 menit, vault menolak semua percobaan (termasuk yang benar) sampai jeda selesai.

### 8.3 Import key
1. Pastikan address sudah terdaftar di **Addresses** (dengan owner reference) dan **tidak diarsipkan**.
2. Buka vault, lalu di bagian **Import key** pilih address dari inventaris, lalu pilih jenis input:
   - **Private key**: 64 karakter hex (boleh diawali `0x`).
   - **Seed phrase + derivation path**: 12/24 kata. Path default `m/44'/60'/0'/0/0` (akun pertama). Untuk akun ke-2 pakai `.../0/1`, dan seterusnya. **Hanya private key di path itu yang disimpan; seed phrase tidak disimpan.**
3. Sistem menurunkan address dari key. Jika **tidak sama** dengan address yang dipilih, import ditolak dan tidak ada yang disimpan.
4. Daftar **Key tersimpan** hanya menampilkan address, entri inventaris yang cocok (satu key EVM berlaku untuk address yang sama di semua network EVM), jenis, dan tanggal import. Isi key tidak pernah ditampilkan di daftar.

### 8.4 Menampilkan key (break-glass)
1. Klik **Tampilkan key** pada baris key, lalu isi **passphrase vault** dan **kode authenticator yang baru** (satu kode hanya berlaku sekali).
2. Key tampil **tersamar**. Klik **Lihat** untuk memperlihatkannya. Kotak tertutup **otomatis setelah 60 detik**, atau klik **Tutup**.
3. Maksimal **3 kali per jam**. Setiap tampilan tercatat (`KEY_REVEALED`) tanpa isi key.
4. Pastikan tidak ada orang lain atau software perekam layar. Fitur ini bisa dimatikan total di server dengan `KEY_REVEAL_ENABLED=false`.

### 8.5 Ganti passphrase / pemulihan
Bagian **Pengaturan passphrase**:
- **Ganti passphrase utama:** isi passphrase saat ini dan yang baru. Key yang tersimpan tidak berubah.
- **Lupa passphrase utama:** isi **recovery passphrase** dan passphrase utama baru. Vault terkunci setelahnya, dan semua key tetap bisa dibuka dengan passphrase baru.

### 8.6 Jika muncul pesan error
| Pesan | Arti / tindakan |
|-------|-----------------|
| Wrong passphrase | Passphrase vault salah (dicatat). Setelah 5 kali, tunggu 15 menit |
| The vault is locked | Buka vault dulu |
| …does not control the selected address | Key/seed/path tidak cocok dengan address yang dipilih. Periksa pilihan address atau derivation path |
| The signer service is not reachable | Service signer mati atau tidak dikonfigurasi. Hubungi pengelola server |
| Reveal limit reached | Sudah 3 kali dalam satu jam, tunggu |

## 9. Verifikasi kepemilikan · *Fase 7*

1. Buka **Address Detail**, lalu **Authorizations**, lalu **Tambah Otorisasi**.
2. Pilih tipe (Milik sendiri / Mandat / Kontrak), lalu unggah atau rujuk dokumen.
3. Klik **Buat Challenge**. Sistem menampilkan pesan yang berlaku 15 menit.
4. Tandatangani pesan:
   - **Key ada di vault** (SUPER_ADMIN, vault unlocked): klik **Verify with Vault**.
   - **Key tidak di vault:** **Connect Wallet**, lalu **Sign**, atau tanda tangani di perangkat offline lalu tempel signature-nya.
5. Hasilnya **VERIFIED** (berhasil), **REJECTED** (signature tidak cocok), atau **EXPIRED** (buat challenge baru).

> Private key/seed hanya boleh dimasukkan di menu **Key Vault → Import key** oleh SUPER_ADMIN. Halaman lain atau orang lain yang meminta key **bukan** bagian dari prosedur sistem ini.

## 10. Wallet tujuan & kelayakan · *Fase 8*

1. **Settings → Destinations → Tambah**: address tujuan + label.
2. REVIEWER lain meng-approve destination tersebut.
3. Menu **Recovery** menampilkan status kelayakan tiap address:

| Status | Arti | Tindakan |
|--------|------|----------|
| READY | Siap diproses | Lanjut ke preview |
| NOT_VERIFIED | Kepemilikan belum terverifikasi | Lakukan langkah 9 |
| NO_KEY_IN_VAULT | Key address belum di-import ke vault | SUPER_ADMIN melakukan langkah 8.3 |
| NO_DESTINATION | Belum ada destination yang di-approve | Lakukan langkah 10.1–10.2 |
| NOT_ECONOMIC | Fee ≥ nilai aset | Biarkan, atau tunggu fee turun |
| NEEDS_GAS_FUNDING | Token tanpa saldo native untuk gas | Keputusan manual: top-up gas atau abaikan |

## 11. Proses recovery · *Fase 9–11*

1. **Preview** (ANALYST): pilih address READY, pilih destination, lalu klik **Buat Preview**. Periksa Source, Destination, Asset, Amount, Fee, dan Network.
2. **Approve** (REVIEWER, bukan pembuat preview): buka transaksi, cocokkan detail, isi alasan, lalu **Approve** atau **Reject**.
3. **Sign** (SUPER_ADMIN): pastikan vault unlocked, lalu buka menu **Signing**, periksa ulang detail, klik **Sign**, dan masukkan kode MFA jika diminta.
   Sistem hanya menandatangani data yang persis sama dengan yang di-approve. Jika data berubah, transaksi ditolak.
4. **Broadcast** (SUPER_ADMIN): klik **Broadcast**, lalu pantau status di **Transactions** sampai **CONFIRMED**.

**Saran:** untuk destination baru di mainnet, kirim jumlah kecil dulu sebagai uji coba.

## 12. Audit log · *Fase 12* · AUDITOR

Menu **Audit Logs**: filter per user, aksi, resource, dan tanggal. Log tidak bisa diedit atau dihapus.
AUDITOR sebaiknya rutin memeriksa aksi SUPER_ADMIN: `VAULT_UNLOCKED`, `KEY_IMPORTED`, `KEY_REVEALED`, `TX_SIGNED`.

## 13. Troubleshooting

| Masalah | Kemungkinan penyebab | Solusi |
|---------|---------------------|--------|
| Scan gagal `RPC_RATE_LIMIT` | Kuota provider habis | Tunggu, kecilkan batch, atau upgrade plan provider |
| Status "Requires review" | Data RPC ≠ explorer | Cek manual di explorer, lalu tandai sudah direview |
| Signature REJECTED | Address di wallet berbeda / pesan berubah | Pastikan akun wallet yang aktif sesuai address, lalu buat challenge baru |
| "Vault locked" saat sign/verify | Sesi unlock habis (auto-lock) | Unlock ulang di Key Vault |
| Import key ditolak | Key tidak cocok dengan address mana pun di inventory | Cek address & derivation path, pastikan address sudah terdaftar |
| Unlock gagal | Passphrase salah | Coba lagi dengan hati-hati, atau gunakan recovery passphrase (8.5) |
| Approval kedaluwarsa | Fee/saldo berubah | Buat preview baru |
| Tx lama PENDING | Fee terlalu rendah saat padat | Lihat runbook operasional (Fase 14) |

## 14. Runbook operasional · *Fase 14*

*(Diisi saat Fase 14: deploy, backup/restore aplikasi + vault, uji pemulihan vault dengan recovery passphrase, rotasi secret, penanganan tx stuck, insiden keamanan.)*

## 15. Yang boleh & tidak boleh

| ✅ Boleh | ❌ Tidak boleh |
|---------|---------------|
| Scan address milik sendiri atau yang punya mandat | Menambahkan address milik orang lain tanpa izin |
| Menyimpan bukti mandat di sistem | Memasukkan private key/seed di tempat selain Key Vault → Import |
| SUPER_ADMIN menyimpan recovery passphrase di brankas fisik | Menyimpan passphrase di chat, email, cloud, atau foto |
| Lock vault segera setelah selesai | Membiarkan layar terbuka saat vault unlocked atau saat reveal |
| Uji coba di testnet | Langsung memakai mainnet tanpa uji end-to-end |
| Mengirim jumlah kecil sebagai uji ke destination baru | Meng-approve transaksi yang tidak Anda periksa sendiri |
