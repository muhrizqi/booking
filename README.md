# Guest House Masjid Jogokariyan

Aplikasi web ringan untuk melihat tanggal kosong dan booking guest house. Dibuka dari HP Android maupun iPhone tanpa instal apa pun.

**Alur**

1. Calon penyewa melihat kalender kosong, memilih tanggal, mengisi nama dan nomor WhatsApp.
2. Admin menerima pesan WhatsApp berisi detail booking dan link ke panel admin.
3. Admin mengecek DP, lalu memilih **Terima** atau **Tolak** di panel.
4. Penyewa menerima WhatsApp: booking dikonfirmasi, beserta jam check-in, check-out, dan aturan menginap.

Tanggal yang sudah diterima otomatis tertutup di kalender. Booking yang belum diproses menahan tanggal selama 24 jam (bisa diubah), supaya tidak terjadi dua orang memesan tanggal yang sama.

## Menjalankan di komputer

Butuh Node.js 22.13 atau lebih baru.

```bash
npm install
cp .env.example .env      # lalu isi ADMIN_PASSWORD
npm start
```

Windows PowerShell:

```powershell
npm install
$env:ADMIN_PASSWORD="passwordku"; npm start
```

Buka http://localhost:3000 (publik) dan http://localhost:3000/admin (admin). Data tersimpan di folder `data/` (SQLite, tanpa instal database).

## Deploy dengan Coolify

1. Unggah proyek ini ke GitHub.
2. Di Coolify: **New Resource**, pilih repository, **Build Pack: Dockerfile**.
3. **Ports Exposes**: `3000`. Isi domain, misalnya `guesthouse.lewat.web.id`.
4. **Environment Variables** (lihat `.env.example`):
   - `ADMIN_PASSWORD` (wajib)
   - `BASE_URL` (alamat domain lengkap dengan https, dipakai untuk link di pesan WhatsApp)
   - `WA_PROVIDER`, `FONNTE_TOKEN` atau `WAHA_URL` / `WAHA_API_KEY` / `WAHA_SESSION`
5. **Persistent Storage**: tambahkan volume yang dipasang ke `/data`. Tanpa ini, data booking hilang setiap kali redeploy.
6. Deploy. Health check: `/healthz`.

Setelah login admin, buka **Pengaturan** dan isi informasi rekening DP, jam check-in dan check-out, serta aturan menginap.

## WhatsApp otomatis

- `WA_PROVIDER=fonnte` dengan `FONNTE_TOKEN`, atau
- `WA_PROVIDER=waha` dengan `WAHA_URL` (dan `WAHA_API_KEY`, `WAHA_SESSION` bila dipakai).
- `WA_PROVIDER=none` (bawaan): pesan tidak dikirim otomatis, tetapi tetap dicatat di menu **Pesan** dan bisa dikirim lewat tombol WhatsApp di kartu booking.

Pesan yang dikirim: booking baru ke admin, dan penyewa saat booking diterima, ditolak, atau dibatalkan. Pesan yang gagal bisa dikirim ulang dari menu **Pesan**.

## Panel admin

- **Booking**: daftar menunggu, diterima, ditolak atau batal. Terima, tolak, atau batalkan dengan satu ketukan.
- **Kalender**: lihat isi tiap malam, blokir tanggal (perbaikan, acara masjid), dan tambah booking manual untuk tamu dari WhatsApp, telepon, atau OTA.
- **Pengaturan**: nomor WhatsApp admin, rekening DP, persentase DP, jam check-in dan check-out, daftar aturan, harga, kapasitas, biaya tamu tambahan, dan isi rumah.
- **Pesan**: log semua pesan WhatsApp.

Alamat panel bisa diganti dengan `ADMIN_PATH`, misalnya `/atur`.

## Struktur

```
server.js            API dan penyajian halaman
src/db.js            skema SQLite dan data awal
src/wa.js            pengiriman WhatsApp (Fonnte, WAHA)
src/messages.js      isi pesan WhatsApp
src/util.js          tanggal, nomor telepon, pembatas laju
public/              halaman publik (index.html, css, js)
views/admin.html     halaman admin (tidak disajikan sebagai file statis)
Dockerfile           untuk Coolify
```

## Persiapan pengembangan berikutnya

Database sudah memakai tabel `units`: setiap booking dan blokir terikat ke `unit_id`, dan API menerima parameter `unit`. Menambah unit guest house atau kamar hotel tinggal menambah antarmuka pemilih unit di halaman publik dan admin. Fitur lain (channel manager OTA, payment gateway, housekeeping, POS, laporan) bisa ditambahkan sebagai tabel dan menu baru tanpa mengubah alur yang ada.

## Backup

Seluruh data ada di `/data/guesthouse.db`. Gunakan fitur backup volume Coolify, atau salin file tersebut (beserta `guesthouse.db-wal` bila ada) secara berkala.
