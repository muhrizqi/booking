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
   - `PORT` (sesuai Ports Exposes di Coolify)
   - Jangan isi `DATA_DIR`. Di Docker sudah otomatis `/data`.
   - Pengaturan WhatsApp tidak perlu lewat environment variable, atur dari menu Pengaturan di panel admin.
5. **Persistent Storage**: tambahkan volume yang dipasang ke `/data`. Tanpa ini, data booking hilang setiap kali redeploy.
6. Deploy. Health check: `/healthz`.

Setelah login admin, buka **Pengaturan** dan isi informasi rekening DP, jam check-in dan check-out, serta aturan menginap.

## WhatsApp otomatis

Semua diatur dari **Admin, menu Pengaturan**, tanpa mengubah environment variable atau redeploy:

- **Nomor admin**: satu nomor per baris (maksimal 5). Semua nomor menerima pemberitahuan booking baru.
- **Penyedia**: WAHA, Fonnte, atau belum aktif.
- **WAHA**: alamat WAHA, nama sesi, dan API key. API key tersimpan di server dan tidak pernah ditampilkan kembali di browser.
- **Cek koneksi** menampilkan status sesi WAHA dan nomor akun pengirim. **Kirim pesan uji** mengirim pesan ke semua nomor admin dan menampilkan hasil per nomor.

Catatan penting: nomor admin harus berbeda dari nomor akun yang terhubung ke WAHA. Pesan dari sebuah nomor ke nomor itu sendiri tidak muncul sebagai notifikasi. Aplikasi memberi peringatan bila keduanya sama.

Jika `WA_PROVIDER`, `WAHA_URL`, `WAHA_API_KEY`, `WAHA_SESSION`, atau `FONNTE_TOKEN` sudah ada di environment saat database pertama kali dibuat, nilainya dipakai sebagai nilai awal. Setelah itu menu Pengaturan yang berlaku.

Dengan penyedia "belum aktif", pesan tidak dikirim otomatis tetapi tetap dicatat di menu **Pesan** dan bisa dikirim lewat tombol WhatsApp. Pesan yang gagal bisa dikirim ulang dari menu **Pesan**.

## Harga

Harga dihitung **per malam menginap**, dengan urutan prioritas:

1. **Harga khusus tanggal** (menu Harga): nama, rentang tanggal, harga per malam, dan minimal menginap. Untuk tanggal merah, libur sekolah, Tahun Baru, Idul Fitri, Idul Adha, dan sejenisnya. Bila dua aturan tumpang tindih, aturan dengan rentang paling sempit yang dipakai (misalnya "Malam Tahun Baru" mengalahkan "Libur Natal dan Tahun Baru").
2. **Harga akhir pekan**, untuk malam yang Anda pilih (bawaan Jumat dan Sabtu). Kosongkan bila sama dengan hari biasa.
3. **Harga hari biasa**.

Contoh: menginap Jumat sampai Senin berarti 3 malam: Jumat dan Sabtu memakai harga akhir pekan, Minggu memakai harga hari biasa, kecuali ada aturan khusus.

Aturan "minimal menginap" berlaku bila ada satu malam dalam masa menginap yang tercakup aturan itu. Tamu yang melebihi kapasitas normal dikenai biaya tambahan per orang per malam (bila diisi). Perubahan harga tidak memengaruhi booking yang sudah dibuat, karena total dikunci saat booking dikirim. Tanggal merah tidak diisi otomatis; masukkan sendiri dari kalender resmi pemerintah setiap tahun.

## Panel admin

- **Booking**: daftar menunggu, diterima, ditolak atau batal. Terima, tolak, atau batalkan dengan satu ketukan.
- **Kalender**: lihat isi tiap malam, blokir tanggal (perbaikan, acara masjid), dan tambah booking manual untuk tamu dari WhatsApp, telepon, atau OTA.
- **Harga**: harga hari biasa, harga akhir pekan, harga khusus tanggal (tanggal merah, Tahun Baru, hari raya, libur sekolah), dan pratinjau 28 malam ke depan. Lihat bagian "Harga" di bawah.
- **Pengaturan**: nomor WhatsApp admin dan koneksi WAHA, rekening DP, persentase DP, jam check-in dan check-out, daftar aturan, kapasitas, dan isi rumah.
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
