# Arsitektur dan API Fulfill

Aplikasi mandiri Node.js 24 + Express, PostgreSQL melalui `pg`/`DATABASE_URL`, dan React/TypeScript. Tidak memuat arsip Apps Script. Dalam production, Express menyajikan hasil build Vite dan API dari origin yang sama.

## Data dan akses

- Schema privat `fulfill` dibuat melalui `npm run db:migrate`; runtime tidak membuat schema atau membaca SQLite. Migration berversi dan checksum disimpan di `fulfill.schema_migrations`.
- Semua query database asynchronous. Transaksi memakai satu client PostgreSQL dengan transaction-scoped advisory lock untuk mempertahankan urutan penulisan bisnis. Aplikasi tetap dioperasikan sebagai satu instance karena penjagaan upload dan pembatas login berada dalam memori.

- `users` dan sesi cookie HttpOnly mengatur peran `admin`, `picker`, `packer`. Password di-hash memakai scrypt; token sesi disimpan sebagai hash. Reset password atau penonaktifan membatalkan sesi.
- Pesanan mempunyai `version` dan status `NEW → READY → PACKING → PACKED`. Penyelesaian checklist membutuhkan versi terkini. Perubahan barang membatalkan kesiapan lama.
- Sesi rekaman memiliki `clientId` untuk idempotensi dan kunci unik satu rekaman aktif per resi. Rekaman terputus mengembalikan pesanan ke READY, dengan bukti berstatus INTERRUPTED.
- Video final berada di Google Drive. Multipart upload menggunakan spool sementara di server yang dibersihkan sesudah percobaan upload. IndexedDB menyimpan cadangan di perangkat hingga konfirmasi Drive dan database.
- OAuth Google memakai scope `drive.file`, state acak sekali pakai yang terikat admin, token refresh terenkripsi, dan folder yang dibuat aplikasi. Video diputar melalui proxy API berotorisasi dengan dukungan byte ranges.

## Endpoint utama

Respons sukses berupa objek JSON. Respons kegagalan non-2xx berbentuk `{error, code?}`. File upload memakai multipart.

| Endpoint | Peran | Tujuan |
| --- | --- | --- |
| GET `/api/health` | Publik | SELECT 1; 200 jika database terhubung, 503 jika tidak tersedia |
| GET `/api/auth/me` | Semua | Pengguna aktif atau null |
| POST `/api/auth/login`, `/api/auth/logout` | Semua | Sesi login |
| GET `/api/dashboard`, `/api/orders` | Admin | Ringkasan, pencarian/filter |
| GET `/api/orders/:tracking` | Semua peran login | Satu pesanan |
| POST `/api/imports/preview` | Admin | Baca file CSV/XLSX tanpa mutasi |
| POST `/api/imports/confirm` | Admin | Validasi ulang dan simpan satu transaksi |
| GET/POST `/api/users`, PATCH `/api/users/:id` | Admin | Akun dan akses tim |
| POST `/api/picking/:tracking/complete` | Picker | Checklist seluruh indeks barang + version |
| POST `/api/recordings/start` | Packer | Klaim pesanan READY memakai clientId |
| POST `/api/recordings/:id/upload` | Packer pemilik | Video, duration, interrupted → Drive |
| POST `/api/recordings/:id/cancel` | Packer pemilik | Batalkan sesi yang belum tersimpan |
| PATCH `/api/recordings/:id/release` | Admin | Lepas sesi terbengkalai, wajib confirm:true |
| GET `/api/recordings` | Admin | Cari bukti berdasarkan resi/pesanan |
| GET `/api/recordings/:id/video` | Admin/packer pemilik | Streaming privat dari Drive |
| GET `/api/integrations/drive/status` | Admin/packer | Status tanpa nilai credential |
| POST `/api/integrations/drive/connect` | Admin | URL consent Google |
| GET `/api/integrations/drive/callback` | Admin | Verifikasi state dan simpan token |

Tipe payload antarmuka berada di `src/types.ts`. Implementasi dan tes perilaku API berada di `server/` dan `tests/api.test.mjs`; OAuth diuji terisolasi pada `tests/drive.test.mjs`.
