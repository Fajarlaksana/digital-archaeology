# Analisa Sistem — Digital Archaeology / Unclaimed Digital Asset Recovery

## 1. Tujuan Sistem

Sistem ini dirancang untuk membantu proses identifikasi dan pemulihan aset kripto yang tidak aktif dalam jangka waktu panjang, dengan fokus pada alamat yang memiliki saldo kecil dan hanya dapat diproses apabila terdapat bukti kepemilikan atau otorisasi yang sah atas private key.

Tujuan utama sistem:

- Mengidentifikasi address yang tidak aktif dalam periode tertentu.
- Mengambil data saldo dan aktivitas blockchain secara otomatis.
- Menghitung estimasi nilai aset berdasarkan saldo.
- Menyediakan proses verifikasi kepemilikan berbasis signature tanpa mengekspos private key.
- Menghitung kelayakan pemulihan berdasarkan saldo, biaya transaksi, dan tujuan transfer.
- Mencatat seluruh aktivitas secara auditable.
- Mendukung penyaluran aset yang telah diverifikasi ke wallet tujuan yang telah ditentukan.
- Menyediakan laporan hasil pemindaian, verifikasi, dan transfer.

## 2. Batasan Sistem

Sistem hanya boleh digunakan untuk:

- Wallet milik pengguna sendiri.
- Wallet yang private key atau seed phrase-nya diperoleh secara sah dari pemilik.
- Wallet yang terdapat surat, kontrak, mandat, atau otorisasi pemulihan yang sah.
- Aset yang pengguna berwenang untuk kendalikan.

Sistem tidak dirancang untuk:

- Mencari atau mencoba private key milik pihak lain.
- Brute-force private key.
- Menebak seed phrase.
- Memanfaatkan credential hasil kebocoran untuk mengakses aset pihak lain.
- Mengakses database internal, exchange, layanan, atau sistem yang tidak memberikan izin.
- Mengklaim aset hanya berdasarkan fakta bahwa sebuah address sudah lama tidak aktif.

Status tidak aktif pada blockchain bukan bukti bahwa aset telah menjadi milik pihak lain.

## 3. Konsep Arsitektur

Sistem terdiri dari beberapa komponen utama:

```text
+----------------------+
|      Web Dashboard   |
+----------+-----------+
           |
           v
+----------------------+
|       API Server     |
+----------+-----------+
           |
     +-----+-----+
     |           |
     v           v
+---------+  +---------+
| Scanner |  | Ledger  |
| Engine  |  | Service |
+----+----+  +----+----+
     |            |
     v            v
+---------+  +---------+
| RPC /   |  |Database |
| Explorer|  |         |
+---------+  +---------+

        +----------------+
        | Key Vault /    |
        | Signing Module |
        +-------+--------+
                |
                v
        +----------------+
        | Transaction    |
        | Broadcaster    |
        +----------------+
```

## 4. Modul Sistem

### 4.1 Dashboard

Dashboard menampilkan:

- Total address yang dipindai.
- Total address tidak aktif.
- Total address yang memenuhi kriteria saldo.
- Total aset yang dapat diproses.
- Total aset yang telah diverifikasi.
- Total aset yang telah ditransfer.
- Total estimasi biaya transaksi.
- Riwayat aktivitas terbaru.
- Status pekerjaan scanner.

Dashboard tidak menyimpan private key secara langsung.

### 4.2 Address Scanner

Modul scanner bertugas mengumpulkan data publik dari blockchain.

Input:

- Network.
- Daftar address yang memang dimiliki atau telah diberi otorisasi.
- Batas waktu tidak aktif.
- Minimum saldo.
- Maximum saldo.
- Token yang ingin diperiksa.

Data yang dikumpulkan:

- Address.
- Network.
- Native balance.
- Token balance.
- Timestamp transaksi terakhir.
- Block transaksi terakhir.
- Jumlah transaksi masuk.
- Jumlah transaksi keluar.
- Status aktif/tidak aktif berdasarkan parameter sistem.

Contoh status:

```text
ACTIVE
INACTIVE
NO_BALANCE
REQUIRES_REVIEW
AUTHORIZED
READY
TRANSFERRED
```

### 4.3 Activity Analyzer

Modul ini menghitung periode tidak aktif.

Contoh:

```text
last_activity = 2023-08-10
scan_date     = 2026-10-01
inactive_days = 1148
```

Aturan:

```text
inactive_days >= inactivity_threshold
```

Threshold dapat dikonfigurasi, misalnya:

```text
730 hari = 2 tahun
1095 hari = 3 tahun
1460 hari = 4 tahun
```

Perlu dibedakan antara:

- Tidak ada transaksi keluar.
- Tidak ada transaksi masuk.
- Tidak ada aktivitas sama sekali.

Definisi status harus disimpan dalam konfigurasi sistem.

### 4.4 Balance Valuation

Modul ini menghitung estimasi nilai aset.

Input:

- Saldo.
- Harga aset.
- Mata uang referensi.
- Timestamp harga.

Output:

```text
asset_quantity
asset_price
estimated_value
```

Contoh:

```text
0.002 BTC
BTC = $70,000
estimated_value = $140
```

Nilai fiat merupakan estimasi dan bukan dasar kepemilikan.

### 4.5 Authorization & Ownership Verification

Sebelum aset dapat diproses, sistem harus memiliki bukti otorisasi.

Model verifikasi:

```text
Address
   |
   v
Challenge Message
   |
   v
User Signs Message
   |
   v
Signature Verification
   |
   v
Ownership Confirmed
```

Sistem memverifikasi bahwa signature sesuai dengan address yang ditentukan.

Private key tidak perlu ditampilkan kepada operator.

Status:

```text
UNVERIFIED
PENDING
VERIFIED
REJECTED
EXPIRED
```

### 4.6 Key Vault

Private key atau seed phrase harus dipisahkan dari database aplikasi.

Prinsip:

- Jangan menyimpan private key dalam plain text.
- Jangan mencatat private key pada log.
- Jangan memasukkan private key ke source code.
- Gunakan vault atau secure keystore.
- Batasi akses berdasarkan role.
- Gunakan encryption at rest.
- Gunakan encryption in transit.
- Audit setiap operasi signing.

Struktur konseptual:

```text
Application
    |
    v
Key Vault
    |
    v
Signing Operation
    |
    v
Signature / Signed Transaction
```

### 4.7 Recovery Eligibility Engine

Modul ini menentukan apakah suatu aset secara operasional layak diproses.

Parameter:

```text
balance_value
estimated_fee
network_fee
minimum_reserve
authorization_status
destination_status
```

Rumus sederhana:

```text
net_value = estimated_value - estimated_fee
```

Kemudian:

```text
if authorization_status != VERIFIED:
    NOT_ELIGIBLE

elif destination_status != APPROVED:
    NOT_ELIGIBLE

elif net_value <= minimum_reserve:
    NOT_ECONOMIC

else:
    READY
```

### 4.8 Transaction Builder

Modul ini membuat transaksi berdasarkan parameter yang telah diverifikasi.

Input:

- Source address.
- Destination address.
- Asset.
- Amount.
- Gas/fee configuration.
- Nonce jika jaringan membutuhkannya.

Sebelum signing:

```text
Source
Destination
Asset
Amount
Fee
Network
```

harus ditampilkan kembali untuk pemeriksaan.

### 4.9 Signing Module

Signing dilakukan pada lingkungan terproteksi.

Alur:

```text
Transaction
     |
     v
Validation
     |
     v
Key Vault
     |
     v
Digital Signature
     |
     v
Signed Transaction
```

Private key tidak dikirim ke client browser.

### 4.10 Transaction Broadcaster

Signed transaction dikirim ke node/RPC provider.

Data yang disimpan:

- Transaction hash.
- Network.
- Source.
- Destination.
- Asset.
- Amount.
- Fee.
- Timestamp.
- Confirmation count.
- Final status.

Status transaksi:

```text
CREATED
SIGNED
BROADCASTED
PENDING
CONFIRMED
FAILED
CANCELLED
```

## 5. Database Design

### 5.1 Table: networks

```text
id
name
chain_id
rpc_endpoint
explorer_url
native_asset
status
created_at
updated_at
```

### 5.2 Table: addresses

```text
id
network_id
address
label
owner_reference
last_activity_at
balance_native
estimated_value
status
created_at
updated_at
```

### 5.3 Table: assets

```text
id
network_id
contract_address
symbol
name
decimals
created_at
updated_at
```

### 5.4 Table: balances

```text
id
address_id
asset_id
quantity
fiat_value
price_source
price_timestamp
updated_at
```

### 5.5 Table: authorizations

```text
id
address_id
authorization_type
reference
verification_status
verified_at
expires_at
created_at
updated_at
```

### 5.6 Table: scans

```text
id
network_id
started_at
completed_at
threshold_days
minimum_balance
maximum_balance
total_addresses
total_inactive
status
error_message
```

### 5.7 Table: transactions

```text
id
address_id
network_id
tx_hash
destination_address
asset_id
amount
network_fee
estimated_value
status
created_at
updated_at
```

### 5.8 Table: audit_logs

```text
id
user_id
action
resource_type
resource_id
ip_address
result
created_at
```

Audit log tidak boleh menyimpan private key, seed phrase, password, atau credential rahasia.

## 6. Alur Sistem Utama

### 6.1 Scan

```text
START
  |
  v
Select Network
  |
  v
Load Authorized Addresses
  |
  v
Read Blockchain Activity
  |
  v
Read Balance
  |
  v
Calculate Inactivity
  |
  v
Calculate Estimated Value
  |
  v
Save Result
  |
  v
END
```

### 6.2 Verification

```text
Select Address
      |
      v
Check Authorization
      |
      v
Generate Challenge
      |
      v
Receive Signature
      |
      v
Verify Signature
      |
   +--+--+
   |     |
 VALID  INVALID
   |     |
   v     v
VERIFIED REJECTED
```

### 6.3 Recovery

```text
VERIFIED
   |
   v
Check Balance
   |
   v
Estimate Fee
   |
   v
Check Economic Threshold
   |
   v
Review Destination
   |
   v
Build Transaction
   |
   v
Sign
   |
   v
Broadcast
   |
   v
Confirm
   |
   v
Record Audit Log
```

## 7. API Design

### GET

```text
GET /api/networks
GET /api/addresses
GET /api/addresses/:id
GET /api/addresses/:id/balances
GET /api/addresses/:id/activity
GET /api/scans
GET /api/transactions
GET /api/audit-logs
```

### POST

```text
POST /api/scans
POST /api/authorizations
POST /api/authorizations/:id/verify
POST /api/transactions/preview
POST /api/transactions/sign
POST /api/transactions/broadcast
```

### PATCH

```text
PATCH /api/addresses/:id
PATCH /api/authorizations/:id
PATCH /api/transactions/:id
```

## 8. Security Architecture

### 8.1 Authentication

Gunakan:

- Password hashing.
- Session/token authentication.
- Multi-factor authentication untuk operasi signing.
- Session timeout.
- Rate limiting.

### 8.2 Authorization

Role contoh:

```text
ADMIN
ANALYST
REVIEWER
SIGNER
AUDITOR
```

Contoh:

```text
ANALYST
- scan
- read
- report

REVIEWER
- review authorization
- approve transaction

SIGNER
- sign approved transaction

AUDITOR
- read audit logs
```

### 8.3 Secrets

Semua secret harus berasal dari environment atau secret manager.

Contoh:

```text
RPC_URL
DATABASE_URL
PRICE_API_KEY
VAULT_ENDPOINT
VAULT_TOKEN
```

Jangan menaruh secret di repository.

## 9. Error Handling

Jenis error:

```text
RPC_TIMEOUT
RPC_RATE_LIMIT
INVALID_ADDRESS
INVALID_NETWORK
BALANCE_READ_FAILED
ACTIVITY_READ_FAILED
PRICE_UNAVAILABLE
AUTHORIZATION_FAILED
SIGNATURE_INVALID
INSUFFICIENT_BALANCE
FEE_ESTIMATION_FAILED
TRANSACTION_FAILED
```

Setiap error harus memiliki:

```text
code
message
timestamp
request_id
resource_id
```

Jangan memasukkan secret ke error message.

## 10. Monitoring

Metrics:

```text
scan_count
scan_success_count
scan_failure_count
addresses_scanned
inactive_addresses
verified_addresses
transactions_created
transactions_confirmed
transactions_failed
rpc_errors
average_scan_duration
```

Health check:

```text
GET /health
GET /health/rpc
GET /health/database
GET /health/vault
```

## 11. Logging

Contoh log yang diperbolehkan:

```text
2026-10-01T10:00:00Z
SCAN_STARTED
network=...
scan_id=...
```

Contoh yang dilarang:

```text
private_key=...
seed_phrase=...
password=...
vault_secret=...
```

## 12. Scheduler

Scanner dapat dijalankan secara berkala.

Contoh:

```text
Daily
Weekly
Manual
```

Job:

```text
SCAN_AUTHORIZED_ADDRESSES
REFRESH_BALANCES
REFRESH_ACTIVITY
UPDATE_PRICE
CHECK_PENDING_TRANSACTIONS
```

## 13. Reporting

Laporan dapat berisi:

```text
Address
Network
Last Activity
Inactive Days
Asset
Balance
Estimated Value
Authorization Status
Recovery Status
Transaction Hash
```

Laporan harus membedakan dengan jelas antara:

- Data blockchain publik.
- Estimasi nilai.
- Data otorisasi.
- Status transaksi.

## 14. User Interface

Halaman utama:

```text
Dashboard
Networks
Addresses
Scans
Authorizations
Recovery
Transactions
Reports
Audit Logs
Settings
```

### Dashboard Cards

```text
Authorized Addresses
Inactive Addresses
Verified Addresses
Recoverable Value
Pending Transactions
Completed Transactions
```

### Address Detail

```text
Address
Network
Balance
Assets
Last Activity
Inactive Duration
Authorization
Transactions
Audit History
```

## 15. Konfigurasi

Contoh:

```env
APP_ENV=production
APP_URL=
DATABASE_URL=
REDIS_URL=

RPC_URL=
EXPLORER_URL=

PRICE_PROVIDER=
PRICE_API_KEY=

INACTIVITY_THRESHOLD_DAYS=730
MIN_RECOVERY_VALUE=
MAX_RECOVERY_VALUE=

VAULT_ENDPOINT=
VAULT_TOKEN=
```

Nilai konfigurasi sensitif tidak boleh dimasukkan ke repository publik.

## 16. Struktur Project

Contoh struktur:

```text
digital-archaeology/
├── backend/
│   ├── src/
│   │   ├── controllers/
│   │   ├── services/
│   │   ├── repositories/
│   │   ├── blockchain/
│   │   ├── auth/
│   │   ├── vault/
│   │   ├── jobs/
│   │   ├── models/
│   │   └── utils/
│   ├── tests/
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   ├── services/
│   │   ├── hooks/
│   │   └── utils/
│   └── package.json
│
├── database/
│   ├── migrations/
│   └── seeds/
│
├── docs/
│   ├── architecture.md
│   ├── api.md
│   ├── security.md
│   └── operations.md
│
├── .env.example
├── .gitignore
├── README.md
└── docker-compose.yml
```

## 17. Testing

### Unit Test

Test:

- Inactivity calculation.
- Balance calculation.
- Fiat valuation.
- Fee calculation.
- Eligibility rules.
- Address validation.
- Signature verification.

### Integration Test

Test:

- RPC connection.
- Database.
- Price provider.
- Vault.
- Transaction broadcaster.

### Security Test

Test:

- Authentication.
- Authorization.
- Rate limiting.
- Secret exposure.
- Log leakage.
- Input validation.
- Replay protection.
- Transaction approval workflow.

## 18. Prinsip Operasional

Sistem harus menerapkan prinsip:

```text
Discover
   ↓
Verify Authority
   ↓
Review
   ↓
Approve
   ↓
Sign
   ↓
Broadcast
   ↓
Confirm
   ↓
Audit
```

Tidak boleh ada proses otomatis yang memindahkan aset hanya karena address memenuhi kriteria "tidak aktif".

## 19. Kriteria Selesai

Sistem dianggap siap digunakan ketika:

- Scanner dapat membaca address yang telah diotorisasi.
- Sistem dapat menghitung inactivity period.
- Sistem dapat membaca saldo secara konsisten.
- Sistem dapat menghitung estimasi nilai.
- Ownership/authorization dapat diverifikasi.
- Private key tidak pernah muncul di browser atau database aplikasi.
- Transaksi harus melalui approval sebelum signing.
- Semua transaksi memiliki audit trail.
- Error RPC dan transaksi dapat ditangani.
- Dashboard dapat menampilkan status end-to-end.
- Automated tests tersedia untuk komponen inti.

## 20. Prinsip Etika dan Kepemilikan

"Dead wallet" adalah klasifikasi aktivitas, bukan bukti bahwa pemilik telah meninggalkan atau melepaskan aset.

Karena itu, sistem harus selalu memisahkan:

```text
Blockchain Inactivity
        ≠
Loss of Ownership
        ≠
Permission to Transfer
```

Aset hanya boleh dipindahkan setelah terdapat dasar kepemilikan atau otorisasi yang sah.

## 21. Output Akhir Sistem

Output utama:

```text
1. Address Inventory
2. Inactivity Report
3. Balance Report
4. Authorization Report
5. Recovery Eligibility Report
6. Transaction Report
7. Audit Report
8. Operational Dashboard
```

## 22. End-to-End Flow

```text
AUTHORIZED ADDRESS LIST
          |
          v
      BLOCKCHAIN
          |
          v
       SCANNER
          |
          v
 ACTIVITY + BALANCE DATA
          |
          v
     ANALYZER
          |
          v
 INACTIVE / ACTIVE STATUS
          |
          v
    AUTHORIZATION
          |
          v
 OWNERSHIP VERIFIED
          |
          v
  ECONOMIC EVALUATION
          |
          v
 TRANSACTION PREVIEW
          |
          v
      APPROVAL
          |
          v
       SIGNING
          |
          v
     BROADCASTING
          |
          v
     CONFIRMATION
          |
          v
        AUDIT
          |
          v
       REPORT
```
