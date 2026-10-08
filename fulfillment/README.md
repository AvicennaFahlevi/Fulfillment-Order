# Fulfill

Sistem fulfillment Shopee mandiri untuk **admin → picker → packer**, dibangun dari awal. Tidak memakai Google Apps Script, kode aplikasi lama, Google Sheets, atau kunci stasiun bersama.

- **Admin** mengimpor ekspor pesanan Shopee, membuat akun tim, dan mencari bukti packing.
- **Picker** masuk dari HP, mencari/memindai resi, dan mencentang barang sesuai SKU, variasi, serta jumlah.
- **Packer** masuk dari laptop, mengaktifkan kamera sekali, lalu memindai resi untuk mulai merekam otomatis.
- **Video final disimpan di Google Drive** akun usaha. Data pesanan, akun, sesi, dan indeks rekaman disimpan di PostgreSQL (termasuk Supabase). File sementara upload dibersihkan setelah percobaan upload.

## Menjalankan di komputer sendiri

Gunakan **Node.js 24** dan npm. Jalankan dari folder `fulfillment`, bukan folder arsip:

```sh
npm ci
# Hanya salin jika .env belum ada; jangan timpa konfigurasi Anda.
cp .env.example .env
# Isi DATABASE_URL di .env, kemudian:
npm run db:migrate
npm run create-admin
npm run dev
```

`create-admin` meminta nama, username, dan password minimal 12 karakter. Input password disembunyikan; tidak ada akun/password bawaan. Akun picker dan packer dibuat kemudian melalui menu **Tim gudang**.

Saat development, frontend memakai port **5173**, backend port **3100**. Buka frontend pada hostname **localhost**, sesuai `APP_ORIGIN` pada `.env`; gunakan hostname yang sama untuk callback OAuth. Server dev hanya mendengarkan komputer sendiri. Jangan membuka file HTML langsung.

Untuk menjalankan hasil build dalam satu server:

```sh
npm run build
# Untuk HTTP lokal satu server, set APP_ORIGIN=http://localhost:3100 di .env.
npm start
```

Akun dan pesanan tetap tersedia setelah restart karena disimpan di PostgreSQL. `DATA_DIR` tetap diperlukan untuk kunci/token Google Drive dan file upload sementara. Pada database baru, impor pesanan sendiri atau gunakan [contoh CSV](examples/pesanan-shopee.csv) di instalasi pengujian.

## PostgreSQL / Supabase

1. Buka **Connect** di proyek Supabase dan ambil connection string PostgreSQL, bukan URL REST atau anon key. Pilih **Direct connection** jika jaringan mendukungnya, atau **Session pooler** untuk jaringan IPv4. Salin host, port, username, dan nama database persis dari dashboard.
2. Isi `DATABASE_URL` pada **`fulfillment/.env`**. Jika sudah ada, pertahankan nilai tersebut. Password yang mengandung karakter khusus harus di-URL-encode. Semua perintah npm di panduan ini dijalankan dari folder `fulfillment`; environment variable server juga dapat dipakai tanpa file `.env`.
3. Jalankan `npm ci`, lalu **`npm run db:migrate`**. Perintah ini membuat schema privat **`fulfill`**, tabel `users`, `sessions`, `orders`, `recordings`, serta tabel pelacak `schema_migrations`. Role koneksi membutuhkan izin membuat schema/tabel. Tidak perlu menambahkan schema ini ke **Exposed schemas** Supabase karena akses dilakukan backend Express melalui PostgreSQL.
4. Migration aman dijalankan ulang: versi yang sudah diterapkan dilewati dan checksum diverifikasi. Seluruh batch berada dalam transaksi; kegagalan di-rollback. Jangan mengedit migration yang sudah diterapkan—tambahkan file bernomor berikutnya. Server tidak menjalankan migration otomatis saat startup.
5. Jalankan `npm run create-admin` untuk membuat akun pertama pada database baru, lalu `npm run dev` atau `npm run build` dan `npm start`.
6. Periksa `GET /api/health` pada backend. Respons `200`: `{"ok":true,"backend":"ok","database":"connected"}`. Jika query database gagal, respons `503`: `{"ok":false,"backend":"ok","database":"unavailable"}`. Health check menjalankan `SELECT 1`; startup juga memeriksa keberadaan tabel pengguna. Respons tidak mengungkap connection string.

Koneksi TLS memverifikasi sertifikat. Untuk Supabase gunakan `sslmode=verify-full`; mode `require` juga dinormalisasi agar tetap memverifikasi sertifikat. Jika penyedia memerlukan CA khusus, gunakan sertifikat resminya melalui parameter `sslrootcert` pada connection string. Jangan menonaktifkan verifikasi sertifikat. `DATABASE_URL` hanya dibaca server; jangan membuat variabel `VITE_DATABASE_URL` atau memasukkan secret ke Git.

Login aplikasi tetap menggunakan username/password dan sesi cookie, bukan Supabase Auth. Endpoint dan payload frontend dipertahankan. Query menggunakan parameter PostgreSQL; `ILIKE` mempertahankan pencarian tanpa membedakan kapitalisasi. Timestamp/JSON tetap TEXT agar format API dan perbandingan pesanan tetap sama; expiry sesi dan ukuran video memakai BIGINT.

Transaksi bisnis memakai satu koneksi dan transaction-scoped advisory lock untuk mempertahankan serialisasi penulisan sebelumnya. Lock dilepas saat commit/rollback; upload jaringan ke Drive dilakukan di luar transaksi. Tetap gunakan satu instance aplikasi: penjagaan upload aktif dan pembatas login masih berada dalam memori proses.

**Data SQLite lama:** runtime tidak lagi membaca atau membuat `fulfill.sqlite`. Migration ini membuat struktur PostgreSQL dan tidak menyalin isi database SQLite lama. Jika memiliki data operasional lama, hentikan penulisan dan cadangkan database tersebut sebelum memindahkan datanya; pertahankan UUID, hash password, relasi, dan `drive_file_id`. Jangan menghapus file SQLite atau kunci/token Drive sebelum hasil pemindahan diverifikasi.

## Menghubungkan Google Drive — tanpa Apps Script

Langkah ini dilakukan pemilik akun Google/admin. Aplikasi tidak membawa kredensial atau akses Drive bawaan.

1. Buat proyek di **Google Cloud Console** dan aktifkan **Google Drive API**.
2. Konfigurasikan **Google Auth Platform / OAuth consent screen**. Untuk pengujian, tambahkan akun Google pemilik Drive sebagai test user. Aplikasi meminta scope `https://www.googleapis.com/auth/drive.file`, untuk file yang dibuat oleh aplikasi.
3. Buat **OAuth Client ID → Web application**. Daftarkan **Authorized redirect URI** yang sama persis dengan konfigurasi server:
   - Development: `http://localhost:3100/api/integrations/drive/callback`.
   - Production: `https://domain-anda/api/integrations/drive/callback`.
4. Isi `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, dan `GOOGLE_REDIRECT_URI` di `.env` atau secret manager server. Jangan memasukkan Client Secret ke browser, Git, atau chat. Restart server setelah mengganti konfigurasi.
5. Masuk sebagai admin, buka **Google Drive**, lalu klik **Hubungkan Google Drive**. Pilih akun milik usaha dan berikan izin.
6. Aplikasi membuat folder **Fulfill — Bukti packing**. Status koneksi dan tautan folder tampil di halaman admin.

Token disimpan terenkripsi pada `DATA_DIR/drive-tokens.enc`; kunci enkripsi berada di `DATA_DIR/drive.key` dengan izin file terbatas. Cadangkan keduanya bersama database. Video tidak dibuat publik secara otomatis; pemutaran melalui aplikasi diperiksa menggunakan hak akses admin/packer pemilik.

OAuth dengan status **Testing** dapat mempunyai refresh token yang kedaluwarsa setelah tujuh hari sesuai aturan Google. Untuk penggunaan harian, sesuaikan status publikasi dan audiens OAuth dengan kebijakan Google/organisasi. Akun yang mencabut izin perlu dihubungkan ulang. Kuota dan kapasitas Drive mengikuti akun Google yang digunakan.

Tanpa koneksi Drive, admin/picking tetap bekerja. Packer masih dapat menghasilkan cadangan lokal, tetapi rekaman belum dianggap tersimpan sampai upload Drive dan catatan database dikonfirmasi. Gunakan satu akun Drive operasional yang tetap agar rekaman lama tetap dapat diakses.

## Alur harian

### 1. Admin mengimpor pesanan

Ekspor detail pesanan dari Shopee Seller Centre setelah resi tersedia. Buka **Impor pesanan**, unggah `.xlsx` atau `.csv`, tinjau hasil pembacaan, lalu konfirmasi.

Kolom utama: **No. Resi**, **No. Pesanan**, **Nama Produk**, **Jumlah**. Kolom pembeli, penerima, status pesanan, variasi, dan SKU juga dikenali. Beberapa baris dengan resi sama menjadi satu pesanan; nol awal pada resi/pesanan dipertahankan. File maksimal 10 MiB. Format Excel lama `.xls` perlu disimpan ulang sebagai `.xlsx` atau `.csv`.

Pratinjau belum mengubah data. Konfirmasi divalidasi ulang dan disimpan dalam transaksi: input yang tidak valid tidak mengimpor sebagian batch. Impor ulang memperbarui resi yang sama. Perubahan barang menghapus konfirmasi picking lama; pesanan yang sedang direkam tidak boleh diubah. Isi pesanan yang sudah selesai packing juga tidak boleh diganti melalui impor ulang.

### 2. Picker memeriksa lewat HP

Masuk memakai akun picker. Ketik resi lalu cari, atau gunakan tombol kamera pada browser yang mendukung `BarcodeDetector`. Jika scan kamera tidak tersedia, pengetikan dan scanner Bluetooth/USB tetap dapat dipakai.

Periksa nama, SKU, variasi, dan **semua unit** pada setiap baris sebelum mencentang. Tombol selesai hanya aktif setelah seluruh baris dicentang. Pemeriksaan tersimpan di server, lengkap dengan akun dan waktu; pesanan berubah menjadi **Siap dikemas**.

Resi yang belum diimpor, dibatalkan, atau belum dibayar tidak dapat diproses. Jika admin mengubah data, picker harus memuat dan memeriksa versi terbaru.

### 3. Packer merekam di laptop

Masuk memakai akun packer, isi nama stasiun, klik tombol aktifkan kamera, lalu izinkan kamera browser. Pastikan area packing terlihat.

Scan resi dengan scanner berakhiran **Enter**, atau ketik dan tekan Enter. Hanya pesanan yang sudah selesai picking yang dapat direkam. Server mengunci satu sesi per resi agar dua packer tidak mengerjakan paket yang sama. Setelah indikator rekaman muncul, mulai packing.

Klik tombol selesai atau scan `STOP`/resi sama untuk menghentikan rekaman. Video diberi identitas resi, packer, stasiun, dan waktu. Tunggu konfirmasi **tersimpan di Google Drive** sebelum menganggap bukti selesai. Rekaman terputus memiliki status berbeda dan pesanan perlu direkam ulang.

**Jika koneksi gagal:** cadangan video tetap berada di IndexedDB browser. Buka aplikasi pada **browser/profil/domain dan akun packer yang sama**, kemudian coba upload kembali atau unduh cadangan. Jangan menghapus data situs saat ada antrean. Browser bisa kehilangan potongan terakhir jika perangkat mati mendadak; cadangan lokal bergantung pada ruang disk dan tidak menggantikan konfirmasi Drive. Admin dapat melepas sesi yang terbengkalai setelah memastikan packer sudah berhenti.

### 4. Menangani komplain

Admin membuka **Bukti packing**, mencari resi/nomor pesanan, lalu memutar atau mengunduh video. Data menampilkan siapa packer, stasiun, waktu, durasi, dan status rekaman. Video di Drive juga dapat dibuka lewat tautan oleh akun yang memiliki akses.

Tidak ada penghapusan video otomatis. Kebijakan retensi dan cadangan bukti diatur pemilik usaha.

## Deployment untuk HP dan laptop

Gunakan **satu server aplikasi**, koneksi PostgreSQL, dan storage lokal persisten untuk metadata OAuth. Antarmuka HP/laptop memakai domain HTTPS yang sama. HTTPS diperlukan untuk akses kamera pada perangkat jarak jauh; HTTP lokal hanya untuk pengembangan di komputer sendiri.

Konfigurasi production:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3100
DATA_DIR=/app/data
APP_ORIGIN=https://domain-anda
COOKIE_SECURE=true
GOOGLE_REDIRECT_URI=https://domain-anda/api/integrations/drive/callback
```

Set `DATABASE_URL` dan Client ID/Secret dari konfigurasi Anda, lalu gunakan Docker atau Node langsung. Contoh Docker:

```sh
# Siapkan .env tanpa menimpa file yang sudah ada.
# Isi DATABASE_URL, domain dan OAuth server Anda.
docker compose build
docker compose run --rm app npm run db:migrate
docker compose up -d
docker compose exec app node server/create-admin.mjs
```

Compose menerbitkan port hanya ke `127.0.0.1:3100`. Letakkan reverse proxy HTTPS di depannya. Izinkan body upload setidaknya **210 MiB** dan timeout upload/proxy minimal **600 detik**. Jangan menayangkan direktori `data/` sebagai file publik. Deployment dan konfigurasi DNS/Google tidak dilakukan otomatis oleh kode ini.

Volume `fulfill-data` harus dipertahankan saat container diperbarui karena berisi kunci/token Drive. Cadangkan PostgreSQL melalui fasilitas backup Supabase atau `pg_dump`; cadangkan juga kunci dan token Drive secara terpisah. Volume aplikasi tidak berisi database PostgreSQL.

## Pengujian

Tes API/migration memakai PostgreSQL nyata. Set **`TEST_DATABASE_URL`** ke server PostgreSQL khusus pengujian dengan role berizin **CREATEDB**, bukan database operasional Supabase. Setiap fixture membuat database `fulfill_test_<uuid>` dan menghapus database itu setelah selesai. Tes tidak menggunakan `DATABASE_URL` sebagai fallback dan tidak memuat `.env` aplikasi.

Contoh PostgreSQL pengujian lokal sementara (trust authentication hanya pada port loopback):

```sh
docker run --rm -d --name fulfill-pg-tests \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:17
export TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/postgres
```

Di PowerShell gunakan `$env:TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:55432/postgres"`. Tunggu PostgreSQL siap sebelum menjalankan tes.

```sh
npm test
npm run build
```

Tes browser membutuhkan Python, Playwright, dan Chromium:

```sh
python -m pip install -r requirements-test.txt
python tests/browser.py
```

Pengujian menggunakan Express, PostgreSQL, autentikasi, impor, picking, dan MediaRecorder browser nyata dengan kamera virtual; layanan Drive dimodelkan supaya tidak mengunggah data ke akun produksi. Tes adapter Drive memeriksa OAuth, token terenkripsi, refresh, dan respons jaringan dengan transport simulasi. Keberhasilan tes lokal tidak membuktikan koneksi akun Supabase atau izin/kapasitas akun Drive sebenarnya. Hentikan container pengujian setelah selesai: `docker stop fulfill-pg-tests`.

Sebelum dipakai tim, lakukan satu impor contoh → pemeriksaan picker → rekaman pendek → pemutaran dari Drive menggunakan akun dan perangkat operasional.

## Struktur

- `src/`: antarmuka React untuk masing-masing peran.
- `server/`: API Express, koneksi PostgreSQL, parser impor, dan integrasi Drive.
- `migrations/`: schema PostgreSQL berversi, dijalankan melalui `npm run db:migrate`.
- `tests/`: pengujian terisolasi; tidak dimuat server production.
- `data/`: data lokal runtime, diabaikan Git dan Docker build.
- `.env`: konfigurasi server lokal, diabaikan Git.

Arsip Apps Script di direktori induk tidak menjadi dependensi aplikasi ini.
