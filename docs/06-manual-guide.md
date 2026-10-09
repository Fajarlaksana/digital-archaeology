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

### 3A.1 Reset MFA (perangkat authenticator hilang) · *Fase 13* ✅
1. **Pastikan identitas orangnya di luar sistem** dulu (mis. video call sambil mencocokkan KTP, atau tatap muka). Jangan pernah mereset hanya berdasarkan chat/email.
2. Di **Users**, klik **Reset MFA** pada baris user tersebut, lalu isi **Verifikasi identitas** (bagaimana identitasnya dipastikan, minimal 10 karakter). Sistem meminta konfirmasi password + kode authenticator Anda bila perlu.
3. Semua sesi user itu langsung berakhir. Saat login berikutnya ia harus memasang authenticator baru (QR).
4. Anda tidak bisa mereset MFA akun sendiri (minta ADMIN lain). MFA **SUPER_ADMIN** hanya bisa direset oleh pengelola server lewat CLI:
   `pnpm --filter backend user:reset-mfa --email <email> --reason "<cara verifikasi identitas>"`
5. Setiap reset tercatat (`MFA_RESET` / `MFA_RESET_CLI`) dan memicu notifikasi Telegram.

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
- Semua laporan ada di menu **Reports** (Fase 12): Address Inventory, Inactivity, Balance, Authorization, Recovery Eligibility, Transaction, dan Audit (khusus AUDITOR). Pilih **network** dan/atau **periode** untuk mempersempit Balance, Authorization, dan Transaction.
- Awalan kolom di laporan baru memisahkan jenis data (SA 13): `chain_` = data blockchain publik, `estimate_` = estimasi nilai (testnet = simulasi), `auth_` = data otorisasi, `status_` = status internal sistem.
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
3. Jika sistem meminta **konfirmasi identitas** (password + kode), kode itu terpakai untuk konfirmasi. Setelah berhasil, tunggu **kode authenticator berikutnya**, isi, lalu klik **Tampilkan** lagi.
4. Maksimal **3 kali per jam**. Setiap tampilan tercatat (`KEY_REVEALED`) tanpa isi key.
5. Pastikan tidak ada orang lain atau software perekam layar. Fitur ini bisa dimatikan total di server dengan `KEY_REVEAL_ENABLED=false`.

### 8.5 Ganti passphrase / pemulihan
Bagian **Pengaturan passphrase**:
- **Ganti passphrase utama:** isi passphrase saat ini dan yang baru. Key yang tersimpan tidak berubah.
- **Lupa passphrase utama:** isi **recovery passphrase** dan passphrase utama baru. Vault terkunci setelahnya, dan semua key tetap bisa dibuka dengan passphrase baru.

### 8.6 Jika muncul pesan error
| Pesan | Arti / tindakan |
|-------|-----------------|
| Wrong passphrase | Passphrase vault salah (dicatat). Setelah 5 kali, tunggu 15 menit |
| Too many wrong passphrases | Batas 5 kali salah dalam 15 menit tercapai (berlaku juga untuk ganti passphrase, recovery, dan reveal). Tunggu 15 menit |
| The vault is locked | Buka vault dulu |
| …does not control the selected address | Key/seed/path tidak cocok dengan address yang dipilih. Periksa pilihan address atau derivation path |
| The signer service is not reachable | Service signer mati atau tidak dikonfigurasi. Hubungi pengelola server |
| Reveal limit reached | Sudah 3 kali dalam satu jam, tunggu |

## 9. Verifikasi kepemilikan · *Fase 7* ✅ · ANALYST / SUPER_ADMIN (lihat: semua role)

Verifikasi punya dua bagian: **otorisasi** (dasar hukum Anda memegang address ini) dan **bukti kendali** (tanda tangan atas pesan challenge sekali pakai).

### 9.1 Menambah otorisasi

1. Buka **Addresses**, pilih address, lalu di bagian **Otorisasi & verifikasi kepemilikan** klik **Tambah otorisasi**.
2. Pilih jenis: **Milik sendiri**, **Kuasa / mandat**, atau **Kontrak**, lalu isi **Referensi** (mis. nomor surat kuasa).
3. Opsional: pilih **Dokumen pendukung**. File **tidak diunggah**; browser hanya menghitung sidik jari SHA-256-nya dan mengirim sidik jari + nama file. Simpan dokumen aslinya di tempat aman. Kelak keasliannya bisa dicek dengan mencocokkan SHA-256 file tersebut.
4. Opsional: isi **Berlaku sampai**. Setelah tanggal itu otorisasi berstatus **EXPIRED** dan tidak bisa dipakai verifikasi.
5. Klik **Simpan otorisasi**. Status otorisasi menjadi **PENDING**, dan status otorisasi address menjadi PENDING (kecuali sudah VERIFIED).

Address yang diarsipkan tidak bisa diberi otorisasi baru; pulihkan dulu.

### 9.2 Membuktikan kendali (challenge)

1. Pada otorisasi, klik **Buat challenge verifikasi**. Sistem menampilkan pesan berisi address, network, nonce acak, dan waktu kedaluwarsa (default 15 menit).
2. Tanda tangani pesan itu dengan salah satu cara:
   - **Tanda tangani dengan wallet browser** (muncul jika ada MetaMask atau sejenisnya): akun aktif di wallet **harus** address yang diverifikasi.
   - **Tempel signature**: tanda tangani pesan persis apa adanya di wallet lain/perangkat offline (`personal_sign` / "Sign message"), lalu tempel hasilnya (`0x…`, 132 karakter) dan klik **Kirim signature**.
   - **Tanda tangani dengan Key Vault** (hanya SUPER_ADMIN, key address sudah di-import dan vault terbuka): sistem meminta konfirmasi password + kode authenticator bila konfirmasi terakhir lebih dari 5 menit lalu.
3. Hasil:
   - **VERIFIED**: otorisasi dan address berstatus terverifikasi.
   - **REJECTED** (*The signature was not made by this address…*): signature bukan dari address ini atau bukan untuk pesan ini. Otorisasi tetap PENDING. Buat challenge baru.
   - **Challenge sudah dipakai / kedaluwarsa**: setiap challenge hanya bisa dicoba **sekali**. Buat challenge baru.

Halaman **Authorizations** menampilkan semua otorisasi dengan filter status; klik address untuk membuka detailnya.

> Verifikasi hanya untuk wallet biasa (EOA). Smart-contract wallet (mis. Safe) belum didukung.

> Private key/seed hanya boleh dimasukkan di menu **Key Vault → Import key** oleh SUPER_ADMIN. Halaman lain atau orang lain yang meminta key **bukan** bagian dari prosedur sistem ini.

## 10. Wallet tujuan & kelayakan · *Fase 8*

### 10.1 Menambah destination · *8a* ✅ · ANALYST
1. Buka **Destinations → Tambah destination**, pilih network, isi **address tujuan** dan **label**, lalu **Simpan**. Address dengan huruf besar/kecil campuran harus checksum-nya benar; address salah ketik ditolak.
2. Status awal **Menunggu approval**. Address dan network tidak bisa diubah lagi.

### 10.2 Membuktikan kendali · ANALYST (bersama pemilik wallet tujuan)
1. Klik **Buktikan kendali**. Sistem menampilkan pesan "Destination Verification" yang berlaku 15 menit dan hanya bisa dipakai sekali.
2. Tanda tangani pesan dengan **wallet tujuan itu sendiri**: lewat **wallet browser** (akun aktif harus address tujuan), atau tanda tangani di perangkat lain lalu **tempel signature**.
3. Jika berhasil, tertulis **Bukti kendali: terverifikasi**. Signature dari address lain ditolak; buat challenge baru.

> Bukti ini mencegah salah ketik atau address tujuan yang ditukar: hanya pemegang wallet tujuan yang bisa membuat signature yang cocok.

### 10.3 Approval · REVIEWER
1. Destination dengan bukti kendali bisa di-**Approve**. Sistem meminta konfirmasi password + kode authenticator bila konfirmasi terakhir lebih dari 5 menit lalu.
2. **Tolak** dan **Nonaktifkan** (untuk destination yang sudah approved, misalnya wallet hilang) wajib disertai alasan.
3. REVIEWER yang ikut mengajukan atau membuktikan destination **tidak bisa** memutuskannya; tombol keputusan disembunyikan dan server menolak dengan `SELF_APPROVAL`.
4. Destination yang ditolak/nonaktif bisa **Ajukan ulang** oleh ANALYST. Bukti kendali dan approval diulang dari awal.

### 10.4 Status kelayakan · *8b* ✅ · semua role (Hitung ulang: ANALYST)
Kelayakan dinilai **otomatis setelah setiap scan**. ANALYST juga bisa menekan **Hitung ulang** di menu **Recovery**, misalnya setelah kepemilikan diverifikasi, destination di-approve, atau key di-import. Fee dibaca ulang dari jaringan setiap kali dinilai.

Menu **Recovery** menampilkan status tiap address (pilih network dan status), lengkap dengan alasan dan tindakan berikutnya. **Address Detail → Kelayakan recovery** menampilkan rinciannya per aset: jumlah, nilai, estimasi fee, dan nilai bersih yang akan diterima. Laporan lengkap: **Unduh laporan kelayakan (CSV)**.

| Status | Arti |
|--------|------|
| **READY** | Minimal satu aset layak diproses. Hanya informasi: **tidak ada aset yang dipindahkan otomatis**. Preview & approval transaksi ada di Fase 9 |
| **NOT_ECONOMIC** | Nilai bersih setelah fee ≤ minimum (default $10) |
| **NOT_ELIGIBLE** | Ada syarat yang belum terpenuhi (lihat alasan) |
| Belum dinilai | Address belum pernah dinilai |

| Alasan | Arti | Tindakan |
|--------|------|----------|
| Saldo sudah lama | Scan terakhir lebih lama dari batas (default 36 jam) | Jalankan scan ulang |
| Tidak ada saldo | Semua saldo nol | Tidak ada yang perlu dipulihkan |
| Kepemilikan belum terverifikasi | Belum ada otorisasi VERIFIED | Langkah 9 |
| Otorisasi kedaluwarsa | Semua otorisasi VERIFIED sudah lewat masa berlaku | Tambah otorisasi baru, verifikasi ulang |
| Belum ada destination approved | Network ini belum punya wallet tujuan yang sah | Langkah 10.1–10.3 |
| Key belum ada di vault | Private key address belum di-import | SUPER_ADMIN, langkah 8.3 |
| Vault tidak bisa dihubungi | Service signer mati/tidak dikonfigurasi | Hubungi pengelola server |
| Harga tidak tersedia | Aset (atau koin native untuk menilai gas) belum punya harga | ADMIN mengatur price id (7.3) |
| Fee tidak bisa diestimasi | RPC gagal membaca fee | Periksa RPC, hitung ulang |
| Fee melebihi saldo | Saldo native habis untuk fee | Biarkan |
| Nilai bersih di bawah minimum | Nilai setelah fee ≤ minimum | Biarkan, atau tunggu fee turun |
| Perlu dana gas | Token bernilai, tetapi tidak ada koin native untuk gas | Keputusan manual: top-up gas atau abaikan |

> Gas untuk token dicadangkan dulu dari saldo native, baru sisanya dinilai sebagai sweep native. Karena itu, sebuah address bisa READY untuk tokennya tetapi NOT_ECONOMIC untuk koin native-nya.

## 11. Proses recovery · *Fase 9–11*

### 11.1 Preview · *Fase 9* ✅ · ANALYST
1. Buka **Address Detail → Kelayakan recovery**, lalu klik **Buat preview** pada aset yang ingin dipindahkan.
2. Pilih **destination** (hanya yang APPROVED di network yang sama) dan jumlahnya:
   - **Seluruh saldo (sweep)**: untuk koin native, saldo dikurangi fee maksimum. Sisa kecil (fee yang tidak terpakai) akan tertinggal.
   - **Test transfer kecil**: isi jumlah yang lebih kecil, disarankan untuk destination baru sebelum sweep.
3. Sistem memeriksa ulang syarat (kepemilikan terverifikasi, destination APPROVED, key ada di vault), lalu membaca **saldo, nonce, dan fee terbaru langsung dari jaringan**. Hasilnya draft berstatus **CREATED**; tidak ada yang dikirim.
4. Satu address hanya boleh punya **satu transaksi aktif**. Selama ada, Address Detail menampilkan tautan ke transaksi itu.

### 11.2 Approve · *Fase 9* ✅ · REVIEWER (bukan pembuat preview)
1. Buka **Transactions**, pilih transaksi berstatus CREATED. Periksa kotak **Periksa sebelum approve**: Source, Destination, Asset, Amount (SWEEP/TEST TRANSFER), Fee maksimum, Network, nonce, dan hash unsigned.
2. Klik **Approve** atau **Tolak**, isi **alasan** (wajib). Sistem meminta konfirmasi password + kode authenticator bila konfirmasi terakhir lebih dari 5 menit lalu.
3. Saat approve, sistem memeriksa ulang jaringan. Jika keadaan sudah berubah, transaksi menjadi **EXPIRED** dan perlu preview baru:

| Alasan kedaluwarsa | Arti |
|--------------------|------|
| Masa berlaku approval habis | Lebih dari 30 menit sejak approve (belum ditandatangani) |
| Nonce address berubah | Ada transaksi lain yang keluar dari address ini |
| Fee jaringan naik di atas batas | Fee saat ini butuh lebih dari batas maksimum yang di-approve |
| Saldo tidak lagi cukup | Saldo < jumlah + fee maksimum |
| Destination tidak lagi APPROVED | Destination dinonaktifkan/ditolak |
| Otorisasi tidak berlaku | Otorisasi kepemilikan kedaluwarsa |

4. Pembuat preview **tidak bisa** meng-approve/menolak transaksinya sendiri, walaupun memegang role REVIEWER. ANALYST bisa **Batalkan** transaksi CREATED/APPROVED (alasan wajib). Setelah ditolak/dibatalkan/kedaluwarsa, address kembali bisa dinilai dan di-preview.

### 11.3 Sign · *Fase 10* ✅ · SUPER_ADMIN (orang ketiga)
1. Buka vault di **Key Vault** (passphrase). Menu **Signing** menampilkan status vault dan antrean transaksi **APPROVED**.
2. Klik transaksi, periksa ulang kotak **Periksa sebelum approve** (source, destination, jumlah, fee maksimum, network, nonce), lalu klik **Sign**. Sistem meminta konfirmasi password + kode authenticator bila konfirmasi terakhir lebih dari 5 menit lalu.
3. Penanda tangan harus **orang ketiga**: bukan pembuat preview dan bukan REVIEWER yang meng-approve (tombol tidak muncul, server menolak `SELF_APPROVAL`).
4. Sebelum menandatangani, sistem memeriksa ulang jaringan (nonce, fee, saldo, masa berlaku approval). Jika berubah, transaksi menjadi **EXPIRED** dan perlu preview baru.
5. Signer hanya menerima **ID transaksi**, membaca sendiri data yang di-approve, dan menolak jika ada yang tidak cocok. Setelah ditandatangani, backend mencocokkan ulang hasilnya dengan data yang di-approve. Hasil: status **SIGNED** dan **Tx hash** tampil. Transaksi yang sudah ditandatangani **belum dikirim** ke jaringan.

> Cara memastikan key tidak pernah ke browser: buka DevTools → Network, klik **Sign**, lalu periksa request `POST /api/transactions/<id>/sign`. Body-nya `{}` dan response-nya hanya berisi data transaksi + `txHash`, tanpa private key maupun raw signed transaction.

### 11.4 Broadcast & konfirmasi · *Fase 11* ✅ · SUPER_ADMIN
1. Menu **Signing → Siap di-broadcast** (atau detail transaksi berstatus **SIGNED**): klik **Broadcast**, baca dialog konfirmasi (jumlah, tujuan, network), lalu **Ya, broadcast sekarang**. Konfirmasi ulang password + kode diminta bila perlu.
2. Sebelum mengirim, sistem memverifikasi ulang tanda tangan dan memeriksa jaringan (nonce, fee, saldo). Jika berubah: **EXPIRED** → buat preview baru. Jika node menolak (mis. fee terlalu rendah), status tetap **SIGNED** dan pesan error tampil.
3. Setelah terkirim, status bergerak otomatis (dicek tiap ±30 detik):

| Status | Arti |
|--------|------|
| **BROADCASTED** | Terkirim, menunggu masuk blok |
| **PENDING** | Sudah masuk blok, menunggu konfirmasi (x / 3) |
| **CONFIRMED** | Selesai. Address menjadi **TRANSFERRED** dan saldonya diperbarui |
| **FAILED** | *Reverted* (gagal dieksekusi) atau *nonce dipakai transaksi lain*; address bisa diproses ulang |
| **STUCK** (penanda) | Lebih dari 30 menit tanpa masuk blok. Tetap dipantau, tidak otomatis gagal |

4. Bagian **Status jaringan** di detail transaksi menampilkan konfirmasi, blok, **fee aktual**, dan **Lihat di explorer**.
5. Setelah sweep, sisa debu kecil (fee maksimum − fee aktual) tertinggal di address sumber; itu wajar.

**Saran:** untuk destination baru di mainnet, kirim jumlah kecil dulu sebagai uji coba.

## 12. Audit log · *Fase 12* ✅ · AUDITOR

1. Menu **Audit Logs** menampilkan entri terbaru dulu. Filter: **aksi**, **hasil** (SUCCESS/DENIED/FAILURE), **Resource ID** (mis. ID transaksi), **tanggal**; klik **Terapkan filter**. **Muat lebih banyak** untuk entri lebih lama.
2. Klik sebuah baris untuk melihat **metadata** (data sensitif sudah disamarkan `[REDACTED]` saat dicatat), request ID, dan hash.
3. **Unduh CSV (filter saat ini)** untuk arsip/pemeriksaan di spreadsheet. Unduhan ini juga tercatat.
4. **Verifikasi integritas**: setiap baris terhubung ke baris sebelumnya dengan hash SHA-256. Hasil:
   - **Rantai utuh** + *head* (nomor dan hash baris terakhir). **Catat head ini di luar sistem** (mis. buku catatan/ dokumen terpisah) secara berkala: jika kelak baris terbaru dihapus, head yang tercatat tidak akan cocok lagi.
   - **Rantai RUSAK mulai baris #N**: isi baris diubah atau ada baris yang dihapus/disisipkan langsung di database. Segera laporkan dan amankan server.
5. Log tidak bisa diedit atau dihapus lewat aplikasi maupun user database aplikasi.

### 12.1 Prosedur review berkala (minimal mingguan) · AUDITOR · *Fase 13* ✅
Bagian **Review berkala** di atas daftar menampilkan kapan review terakhir dilakukan dan berapa **aksi sensitif** terjadi sejak itu.

1. Centang **Aksi sensitif saja** lalu **Terapkan filter**. Yang termasuk: vault (dibuka, gagal, dipulihkan, ganti passphrase), import/reveal key, approval destination & transaksi, signing, broadcast, transaksi gagal/STUCK, perubahan user & role, reset MFA, akun terkunci, akses ditolak, dan verifikasi rantai.
2. Untuk setiap entri sejak review terakhir, cocokkan dengan kenyataan:
   - setiap `TX_SIGNED` / `TX_BROADCASTED` punya `TRANSACTION_APPROVED` oleh REVIEWER yang berbeda, dan memang direncanakan;
   - setiap `VAULT_UNLOCKED` ada alasannya (jadwal signing/import); **setiap `KEY_REVEALED` harus bisa dijelaskan oleh SUPER_ADMIN**;
   - `USER_UPDATED` / `MFA_RESET` sesuai permintaan resmi;
   - `ACCESS_DENIED`, `*_FAILED`, `ACCOUNT_LOCKED` berulang → indikasi percobaan penyalahgunaan.
3. Klik **Verifikasi integritas**. Catat **head** (nomor + hash) di luar sistem.
4. Isi **Catatan review** (ringkasan temuan, atau "tidak ada temuan") lalu klik **Tandai sudah direview sampai #N**. Sistem memverifikasi rantai sekali lagi dan menyimpan hasilnya bersama catatan (`AUDIT_REVIEWED`).
5. **Temuan mencurigakan** (reveal tanpa penjelasan, signing tanpa approval yang wajar, rantai rusak): eskalasikan ke pemilik projek, minta SUPER_ADMIN mengunci vault, dan jangan tandai review sebagai bersih.

Notifikasi Telegram (bila dikonfigurasi) mengirim peringatan langsung untuk aksi paling sensitif, sehingga review berkala tidak menjadi satu-satunya pengaman.

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
| Preview mainnet ditolak "First mainnet transfer…" | Destination belum pernah menerima tx CONFIRMED | Kirim transfer uji kecil (bukan sweep, ≤ `MAINNET_FIRST_TRANSFER_MAX_VALUE`) dulu (14.10) |
| Backend/signer berhenti `CONFIG_INSECURE` | Konfigurasi produksi tidak aman | Perbaiki variabel yang disebut di log (14.1) |
| Tx ditandai STUCK | Fee terlalu rendah saat padat | Tunggu; bila perlu speed-up/cancel manual dari wallet dengan nonce yang sama. Sistem menandai FAILED (*replaced or dropped*) bila nonce dipakai tx lain. Lihat 14.7 |

## 14. Runbook operasional · *Fase 14* ✅ · Operator server (+ SUPER_ADMIN untuk vault)

Topologi (ADR-028): satu VPS, Docker Compose (`compose.prod.yml`). Hanya Caddy yang membuka port 80/443. Signer berjalan di network namespace backend dan hanya bisa dihubungi backend lewat `127.0.0.1`. Di bawah ini `dc` = `docker compose -f compose.prod.yml`.

### 14.1 Deploy pertama

1. **Server:** Linux terbaru + Docker Engine & Compose plugin, firewall hanya membuka 22 (SSH key saja), 80, dan 443. Arahkan DNS domain ke IP server.
2. **Kode:** `git clone` repo ke `/opt/digital-archaeology`, checkout tag rilis.
3. **Secret:** salin setiap `deploy/env/*.env.example` menjadi `deploy/env/*.env`, isi nilainya, lalu `chmod 600 deploy/env/*.env`. Buat nilai acak dengan `openssl rand -hex 32` (`MFA_ENCRYPTION_KEY`: `openssl rand -base64 32`; password DB: `openssl rand -base64 32 | tr -d '/+='`). Password di `postgres.env` harus sama dengan yang ada di URL `backend.env`/`signer.env`; `SIGNER_HMAC_SECRET` sama di backend & signer. File ini **tidak pernah** masuk git, chat, atau email.
4. **Backup key:** di komputer offline buat identity age `age-keygen -o da-backup-identity.txt` lalu simpan file itu di dua media offline (lihat 14.4). Salin hanya kunci publiknya (`age-keygen -y …`) ke `deploy/backup/age-recipients.txt` di server.
5. **Build & migrasi:** `dc build`, lalu `dc up -d postgres redis`, `dc run --rm migrate-app`, `dc run --rm migrate-vault`.
6. **Start:** `dc up -d`. Bila ada konfigurasi tidak aman, backend/signer berhenti dengan `CONFIG_INSECURE` (lihat `dc logs backend signer`: pesan menyebut nama variabel yang salah).
7. **User:** `dc exec backend node --import tsx scripts/create-user.ts --email … --name … --role SUPER_ADMIN` (satu-satunya cara membuat SUPER_ADMIN; password diketik tanpa tampil), lalu login, aktifkan MFA, dan buat user lain dari UI. CLI lain (`scripts/reset-mfa.ts`) juga dijalankan dengan `dc exec backend …`, bukan `dc run`, karena backend memakai IP tetap.
8. **Vault:** SUPER_ADMIN melakukan init vault dari UI (8.1). Tulis recovery passphrase sesuai 14.4.
9. **Cek:** `curl -s --resolve DOMAIN:443:127.0.0.1 https://DOMAIN/health/ready` dari server harus `ok`. Dari luar, `/metrics` dan `/health` harus 404.

### 14.2 Upgrade

1. Jalankan backup manual dulu (14.3).
2. `git fetch --tags && git checkout <tag baru>`, lalu `dc build`.
3. `dc run --rm migrate-app && dc run --rm migrate-vault` (migrasi hanya maju; jangan pernah `prisma migrate reset`).
4. `dc up -d`. Signer ikut restart sehingga **vault terkunci**; SUPER_ADMIN perlu unlock lagi bila akan signing.
5. Rollback = checkout tag lama + `dc up -d`, hanya bila migrasi baru kompatibel. Bila tidak, restore dari backup (14.3).

### 14.3 Backup & uji restore

- **Jadwal** (crontab root di host, 01:30 WIB):
  `30 1 * * * cd /opt/digital-archaeology && docker compose -f compose.prod.yml run --rm backup >> /var/log/da-backup.log 2>&1`
- Hasil: `backups/<UTC timestamp>/` berisi `globals.sql.age`, `app.dump.age`, `vault.dump.age`, `MANIFEST`, dan `SHA256SUMS`. Dump langsung dienkripsi age, tanpa plaintext di disk. Backup lokal lebih tua dari `RETENTION_DAYS` dihapus. Bila `RCLONE_REMOTE` diisi (config `deploy/rclone/rclone.conf`), salinan dikirim ke offsite lalu diverifikasi. Pakai bucket dengan **object lock / lifecycle** dan credential yang tidak bisa menghapus, karena server tidak pernah menghapus file di offsite.
- **Pantau:** baris terakhir log harus `backup: OK <timestamp>`. Bila muncul `FAILED`, tangani hari itu juga.
- **Uji restore** (minimal bulanan, dan setelah upgrade besar). Mount identity dari media offline hanya selama uji:
  ```bash
  dc run --rm -v /media/usb/da-backup-identity.txt:/config/age-identity.txt:ro \
    --entrypoint restore-check.sh backup <timestamp>
  ```
  Hasil harus `OK`: checksum cocok, migrasi lengkap, rantai hash audit utuh dan memuat head di MANIFEST, `vault_config` ada. Bandingkan `audit head` dengan head yang dicatat AUDITOR (14.8). Lepas media setelah selesai.
- **Restore sungguhan** (bencana): server baru → deploy 14.1 langkah 1–3 → `dc up -d postgres` → dekripsi dan restore: `globals.sql.age` dengan `psql`, lalu kedua dump dengan `pg_restore --clean --if-exists -d <db>` → `dc up -d` → SUPER_ADMIN unlock vault. Ganti semua secret setelahnya bila server lama dicurigai bocor (14.6).

### 14.4 Recovery passphrase & identity backup (offline, fisik) · SUPER_ADMIN

- Tulis recovery passphrase **tangan di kertas**, dua salinan, di dua lokasi fisik terpisah (brankas kantor + safe deposit box), dalam amplop tersegel bertanggal dan bertanda tangan. Jangan difoto, diketik, atau disimpan di password manager cloud.
- Identity age backup (`da-backup-identity.txt`) disimpan di dua USB terenkripsi di lokasi yang sama dengan recovery passphrase. Tanpa identity, backup tidak bisa dibuka. Tanpa recovery passphrase, vault hasil restore tidak bisa dibuka bila passphrase utama hilang.
- Catat di log fisik siapa yang membuka amplop/USB, kapan, dan untuk apa. Ganti segel setiap kali dibuka.
- Bila SUPER_ADMIN berganti: lakukan uji 14.5 bersama penggantinya, lalu ganti passphrase utama dari UI.

### 14.5 Uji pemulihan vault (minimal per kuartal) · SUPER_ADMIN

Membuktikan backup + recovery passphrase saja cukup untuk memulihkan **semua** key. Idealnya dilakukan di mesin bersih (laptop offline dengan Docker + repo), bukan server produksi:

1. `restore-check.sh` dengan `KEEP=1` untuk mempertahankan DB scratch (`restore_check_vault_…`).
2. Jalankan drill pada salinan tersebut (drill menolak DB bernama `da_vault`):
   ```bash
   VAULT_DATABASE_URL=postgresql://postgres:…@<host>:5432/restore_check_vault_… \
     pnpm --filter signer vault:drill --restored-copy
   ```
   (Di server: `dc run --rm -e VAULT_DATABASE_URL=… migrate-vault node --import tsx scripts/vault-recovery-drill.ts --restored-copy`.)
3. Ketik recovery passphrase (tidak tampil di layar). Hasil harus `DRILL PASSED` dengan jumlah key sesuai inventaris. Setiap key didekripsi dan dicocokkan dengan address-nya, lalu satu tx Sepolia dummy ditandatangani (tidak di-broadcast).
4. Hapus DB scratch: `DROP DATABASE … WITH (FORCE)`. Catat hasil drill di log fisik 14.4.

### 14.6 Rotasi secret

| Secret | Kapan | Cara | Dampak |
|--------|-------|------|--------|
| Password DB (`da`, `da_vault`, `da_signer_ro`) | Tahunan / dugaan bocor | `ALTER ROLE … PASSWORD …` via `dc exec postgres psql -U postgres`, ubah URL di env, `dc up -d` | Restart singkat |
| `REDIS_PASSWORD` | Tahunan | Ubah `redis.env` + `REDIS_URL`, `dc up -d` | Restart singkat |
| `SIGNER_HMAC_SECRET` | Tahunan / dugaan bocor | Nilai baru di backend & signer bersamaan, `dc up -d backend signer` | Vault terkunci, unlock ulang |
| `MFA_ENCRYPTION_KEY` | Hanya bila bocor | Mengganti key membuat secret MFA lama tak terbaca: reset MFA semua user (ADMIN dari UI, SUPER_ADMIN via CLI `user:reset-mfa`), lalu enrol ulang | Semua user enrol MFA ulang |
| `METRICS_TOKEN`, token Telegram | Tahunan / dugaan bocor | Ganti di env + konfigurasi Prometheus/BotFather | — |
| Passphrase vault | Saat SUPER_ADMIN berganti / dugaan bocor | Ganti passphrase dari UI Key Vault | — |
| Identity age backup | Dugaan bocor | Buat identity baru, ganti `age-recipients.txt`; backup lama tetap butuh identity lama | Simpan keduanya sampai backup lama kedaluwarsa |

### 14.7 Tx STUCK

1. Tx ditandai STUCK bila belum ada receipt setelah `TX_STUCK_MINUTES`. Sistem **tidak** menandai FAILED karena waktu.
2. Cek hash di explorer. Bila tx ada di mempool, tunggu; konfirmasi akan dilacak otomatis.
3. Bila tx hilang dari mempool (dropped), jangan buat tx kedua dengan nonce berbeda. Buat preview baru setelah tx lama dipastikan tidak akan masuk. Bila nonce lama sudah dipakai tx lain, sistem menandai FAILED (*replaced or dropped*).
4. Speed-up/cancel hanya dilakukan manual dari wallet dengan nonce yang sama, dan dicatat di catatan transaksi.

### 14.8 Jangkar head audit log · AUDITOR (mingguan)

Saat review berkala (12.1), catat `sequence` + `hash` head rantai audit di luar sistem (email ke diri sendiri, catatan fisik, atau tiket). Bila suatu saat rantai tervalidasi tetapi head-nya lebih pendek atau berbeda dari yang dicatat, berarti ada penghapusan atau penulisan ulang: perlakukan sebagai insiden (14.9).

### 14.9 Insiden keamanan

1. **Bekukan:** SUPER_ADMIN lock vault (UI) atau hentikan signer: `dc stop signer` (master key hilang dari memori). Tolak semua approval yang belum ditandatangani.
2. **Batasi akses:** nonaktifkan user yang dicurigai dan cabut sesinya. Bila server dicurigai disusupi, putus dari jaringan tanpa mematikannya, lalu buat snapshot disk untuk forensik.
3. **Bukti:** verifikasi rantai audit (Audit Logs → Verifikasi), bandingkan dengan head yang dijangkar (14.8), dan simpan export audit CSV serta `dc logs` dalam rentang waktu kejadian.
4. **Pulihkan:** rotasi semua secret (14.6). Bila key mungkin bocor (reveal yang tidak dijelaskan, server disusupi saat vault unlocked), pindahkan aset dari address terkait ke destination aman lewat alur normal secepatnya.
5. Catat kronologi dan keputusan di `docs/07-decisions.md` atau dokumen insiden terpisah.

### 14.10 Mengaktifkan mainnet

Syarat: E2E Sepolia (`docs/08-e2e-sepolia.md`) lulus, uji restore (14.3) dan drill vault (14.5) lulus, monitoring aktif.

1. Di `backend.env`: set `NETWORK_MODE=mainnet` dan tambahkan URL RPC mainnet dalam env var bernama khusus (misalnya `ETHEREUM_RPC_URL=…`), lalu `dc up -d backend`. Badge environment di UI menjadi `production/mainnet`.
2. ADMIN menambahkan network mainnet di menu **Networks** (misalnya `ethereum`, chain ID 1, nama env var RPC `ETHEREUM_RPC_URL`) beserta price id aset native (`ethereum`). Nilai di network ini tidak berlabel SIMULASI dan dijumlahkan terpisah dari testnet.
3. **Transfer pertama ke setiap destination** dibatasi oleh sistem. Preview sweep ditolak, dan nilainya maksimal `MAINNET_FIRST_TRANSFER_MAX_VALUE` (default 25 USD) sampai ada satu tx **CONFIRMED** ke destination itu. Bila harga aset belum tersedia, preview ditolak.
4. Setelah transfer kecil terkonfirmasi, cek saldo di wallet tujuan dengan explorer. Baru setelah itu lakukan sweep.

## 15. Yang boleh & tidak boleh

| ✅ Boleh | ❌ Tidak boleh |
|---------|---------------|
| Scan address milik sendiri atau yang punya mandat | Menambahkan address milik orang lain tanpa izin |
| Menyimpan bukti mandat di sistem | Memasukkan private key/seed di tempat selain Key Vault → Import |
| SUPER_ADMIN menyimpan recovery passphrase di brankas fisik | Menyimpan passphrase di chat, email, cloud, atau foto |
| Lock vault segera setelah selesai | Membiarkan layar terbuka saat vault unlocked atau saat reveal |
| Uji coba di testnet | Langsung memakai mainnet tanpa uji end-to-end |
| Mengirim jumlah kecil sebagai uji ke destination baru | Meng-approve transaksi yang tidak Anda periksa sendiri |
