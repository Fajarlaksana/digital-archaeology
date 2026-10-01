# Digital Archaeology

Sistem inventarisasi, verifikasi kepemilikan, dan pemulihan aset kripto yang sudah lama tidak aktif. Sistem ini **hanya** untuk address milik sendiri atau address yang punya mandat/otorisasi sah.

> **Status saat ini:** Fase 0, semua keputusan arsitektur (ADR-001 s/d 009) sudah diambil. Belum ada kode. Berikutnya: menyiapkan tools & akun, lalu Fase 1.
> Update baris ini setiap kali sebuah fase selesai (lihat [docs/03-roadmap.md](docs/03-roadmap.md)).

---

## Mulai dari mana?

Baca dokumen sesuai urutan berikut:

| # | Dokumen | Isi | Kapan dipakai |
|---|---------|-----|---------------|
| 0 | [system_analysis_digital_archaeology.md](system_analysis_digital_archaeology.md) | Analisa sistem asli: modul, tabel, API, alur | Referensi kebutuhan |
| 1 | [docs/01-project-direction.md](docs/01-project-direction.md) | Arah projek: visi, scope MVP, milestone, stack | Dibaca pertama, sekali |
| 2 | [docs/02-project-analysis.md](docs/02-project-analysis.md) | Kritik & penyempurnaan analisa sistem, celah, risiko | Sebelum mulai coding |
| 3 | [docs/03-roadmap.md](docs/03-roadmap.md) | Langkah kerja per fase + checklist + definition of done | Setiap hari, sebagai to-do |
| 4 | [docs/04-prompting.md](docs/04-prompting.md) | Prompt siap-pakai untuk Claude Code, per fase | Setiap mulai sesi coding |
| 5 | [docs/05-development-guide.md](docs/05-development-guide.md) | Setup lokal, struktur folder, konvensi kode, testing | Saat setup & coding |
| 6 | [docs/06-manual-guide.md](docs/06-manual-guide.md) | Manual pengguna/operator aplikasi | Diisi bertahap per fitur |
| 7 | [docs/07-decisions.md](docs/07-decisions.md) | Catatan keputusan teknis (ADR) | Saat ada keputusan penting |
| – | [CLAUDE.md](CLAUDE.md) | Aturan proyek yang otomatis dibaca Claude Code | Otomatis |

## Langkah pertama (hari ini)

1. Baca **01** dan **02**.
2. Tetapkan 3 keputusan terbuka di **07**: chain pertama, model signing, dan stack. Default yang saya rekomendasikan sudah tertulis di sana.
3. Inisialisasi git, lalu commit semua dokumen ini:
   ```bash
   git init
   git add .
   git commit -m "docs: initial project planning documents"
   ```
4. Buka **04-prompting.md**, lalu jalankan **Prompt Fase 1**.

## Prinsip yang tidak bisa ditawar

- Address yang tidak aktif **tidak sama** dengan aset tak bertuan. Status "tidak aktif" tidak pernah menjadi dasar untuk memindahkan aset.
- Tidak ada brute-force, tebak seed, atau pemakaian key/credential hasil bocoran.
- Private key hanya dipegang **SUPER_ADMIN**, disimpan terenkripsi di Key Vault (service `signer/` terpisah) dan hanya bisa dibuka dengan passphrase-nya. Key tidak pernah ada di database aplikasi, log, maupun repository.
- Setiap transfer wajib melewati: verifikasi → review → approval (oleh orang lain) → signing → audit.
- Semua pengujian dilakukan di **testnet** dulu. Mainnet hanya boleh dipakai setelah alur end-to-end lulus di testnet.
