# Meirista Fulfillment — Shopee

Dua antarmuka dengan satu database Google Sheets dan penyimpanan video Google Drive:

- **Admin dan stasiun packer**: `index.html`. Admin mengimpor pesanan, mengelola picker/packer, dan mencari bukti video. Packer memindai resi di laptop untuk menampilkan barang dan merekam proses packing.
- **Picker di HP**: `picker.html`. Masuk menggunakan kode dan PIN pribadi, cari atau scan resi, periksa nama/SKU/variasi/jumlah, lalu tandai siap packing.

Tidak perlu API Shopee untuk alur impor file. Sinkronisasi API Shopee yang sudah ada tetap opsional.

## 1. Pasang backend Google Apps Script

1. Masuk ke [Google Apps Script](https://script.google.com/) dengan akun Google milik usaha, lalu buat **New project**.
2. Salin `Code.gs` ke file **Code.gs**. Tambahkan file script **Logo.gs** dari repositori jika ingin menyertakan aset logo lama.
3. Tambahkan dua file **HTML**, bernama **index** dan **picker** (huruf kecil). Salin isi `index.html` dan `picker.html` ke masing-masing file. Nama harus tepat.
4. Buka **Project Settings**, aktifkan tampilan file manifest `appsscript.json`, lalu salin manifest dari repositori.
5. Masih di **Project Settings → Script Properties**, tambahkan `ADMIN_INITIAL_PIN` dengan PIN pilihan Anda, 4–8 angka. Ini hanya untuk inisialisasi pertama; jangan memasukkan PIN ke kode atau Git.
6. Simpan, kembali ke editor, pilih fungsi **`setup_`**, lalu klik **Run**. Izinkan akses Google yang diminta. Inisialisasi membuat spreadsheet, tab data, dan folder video; PIN awal diubah menjadi hash dan properti PIN awal dihapus.
7. Buka **Execution log** untuk mendapatkan tautan spreadsheet/folder dan **Station Key**. Simpan Station Key untuk konfigurasi perangkat; jangan membagikannya secara publik.
8. Klik **Deploy → New deployment → Web app**. Pilih **Execute as: Me** dan **Who has access: Anyone**, lalu deploy. Simpan URL yang berakhiran **`/exec`**. Kebijakan Google Workspace perusahaan dapat membatasi pilihan akses ini.

Untuk instalasi yang sudah berjalan, `setup_()` menggunakan spreadsheet/folder yang ada dan menambahkan tabel yang diperlukan tanpa menghapus data. PIN admin yang sudah ada dipertahankan. Setelah memperbarui kode, gunakan **Deploy → Manage deployments → Edit → New version → Deploy**; URL deployment dapat dipertahankan.

## 2. Buka aplikasi dan sambungkan perangkat

**Admin/picker:** aplikasi bisa dibuka langsung dari deployment Apps Script. URL utama `/exec` membuka admin/stasiun; `/exec?app=picker` membuka picker. Isi **Sambungan** dengan URL `/exec` dan Station Key. Informasi ini disimpan per browser, sedangkan sesi login picker disimpan hanya untuk sesi tab.

**Laptop packer:** gunakan `index.html` dari hosting statis **HTTPS** agar kamera dan penyimpanan browser tersedia. Letakkan `index.html` dan `picker.html` pada folder hosting yang sama; gunakan Apps Script sebagai backend yang sama. Ini juga memungkinkan HP dan laptop menggunakan domain yang sama. Hosting tidak perlu menjalankan Node atau database. Hosting/publikasi tidak dilakukan otomatis oleh repositori ini.

Halaman Apps Script menggunakan iframe Google; izin kamera/perekaman di dalamnya dapat dibatasi oleh browser. Bila kamera tidak tersedia, gunakan hosting HTTPS untuk antarmuka packer. Membuka file langsung sebagai `file://` atau melalui HTTP di alamat IP HP bukan jalur yang didukung untuk kamera.

Untuk pengembangan di komputer sendiri:

```sh
cd Fulfillment-Order
python -m http.server 8000 --bind 127.0.0.1
```

Server lokal ini hanya untuk komputer yang menjalankannya. HP memerlukan hosting HTTPS tersendiri. Pustaka Excel dan barcode dimuat dari CDN; impor CSV dan picker tetap dapat berfungsi tanpa pustaka Excel.

## 3. Siapkan akun dan impor order — admin

1. Pilih **Login sebagai Administrator** dan masukkan PIN yang dibuat saat pemasangan.
2. Buka **Admin → Packer**, tambahkan nama dan kode badge untuk setiap packer.
3. Buka **Admin → Akun picker**, buat nama, kode login (misalnya `PICK-001`), dan PIN masing-masing picker. PIN tidak ditampilkan kembali. Akun bisa dinonaktifkan atau PIN diganti; sesi lama kehilangan akses.
4. Ekspor detail pesanan dari Shopee Seller Centre setelah nomor resi tersedia.
5. Buka menu **Pesanan**, lalu unggah `.xlsx`, `.xls`, atau `.csv`. Alternatif: **Admin → Pesanan & Shopee** untuk melihat pemetaan kolom sebelum menekan **Impor**.
6. Pastikan jumlah resi yang tersimpan sesuai. Sistem mengelompokkan baris barang berdasarkan resi dan memperbarui resi yang sama ketika file diimpor ulang.

Kolom wajib: **No. Resi**, **No. Pesanan**, **Nama Produk**, dan **Jumlah**. Kolom pembeli, penerima, variasi, SKU, dan status dikenali bila ada. Nomor resi/pesanan disimpan sebagai teks untuk mempertahankan nol awal. Baris tanpa resi valid dilewati dan dihitung; jumlah nol/negatif/pecahan atau barang kosong pada resi valid ditolak. Jangan ubah nomor resi/pesanan menjadi angka di Excel sebelum ekspor.

Coba dengan [file CSV contoh](examples/pesanan-shopee-contoh.csv) pada instalasi pengujian. Semua data contoh fiktif.

## 4. Ambil dan periksa barang — picker di HP

1. Buka halaman **Picker HP**, lalu masuk menggunakan kode login dan PIN dari admin.
2. Ketik nomor resi lalu cari. Tombol scan kamera tersedia pada browser yang mendukung `BarcodeDetector`; jika tidak, gunakan pengetikan atau scanner barcode.
3. Periksa setiap barang, termasuk **SKU, variasi, dan seluruh jumlah unit**. Centang setiap baris setelah lengkap.
4. Tekan **Selesaikan pemeriksaan**. Nama picker dan waktu pemeriksaan disimpan di Sheets dan terlihat di stasiun packing.

Resi yang belum diimpor, dibatalkan, atau belum dibayar tidak dapat diproses. Jika isi pesanan berubah karena impor ulang, picker harus mengambil data terbaru dan memeriksanya kembali. Menyimpan ulang checklist yang sama tidak menggandakan penyelesaian.

## 5. Rekam packing — packer di laptop

1. Buka **Masuk stasiun packer**, pilih nama packer atau scan badge, dan isi nama meja/stasiun.
2. Tekan **Nyalakan kamera** dan izinkan kamera sekali melalui browser. Pastikan barang dan area packing terlihat jelas.
3. Scan resi memakai scanner USB/Bluetooth dengan akhiran **Enter**; bisa juga mengetik resi dan menekan Enter.
4. Sistem memeriksa resi, menampilkan daftar barang dan status picking, lalu **otomatis mulai merekam**. Mulai packing setelah indikator **Sedang merekam** muncul.
5. Selesaikan dengan **Selesai & simpan**, scan ulang resi yang sama, atau scan `STOP`. Scan resi berikutnya yang valid menyelesaikan rekaman lama sebelum memulai yang baru. Resi tidak dikenal tidak menghentikan rekaman yang sedang berjalan.
6. Tunggu status **Tersimpan di Drive dan tercatat**. Itu berarti file Drive dan catatan Sheets sudah dikonfirmasi, bukan sekadar masuk antrean.

Video memuat nomor resi, waktu, packer, dan stasiun. File disimpan ke subfolder Drive per bulan; catatan Sheets memuat hubungan resi, pesanan, dan file. Status picking ditampilkan sebagai informasi; stasiun tetap dapat merekam pesanan yang sudah diimpor meski picker belum mengonfirmasi.

**Jika koneksi terputus:** potongan video dan antrean disimpan di IndexedDB browser. Buka kembali aplikasi pada browser/profil/domain yang sama, pilih packer yang sesuai, dan tekan **Coba lagi**, atau gunakan **Unduh cadangan**. Jangan menghapus data situs atau memakai mode incognito untuk rekaman operasional. Penyimpanan lokal bergantung pada ruang perangkat; aplikasi memblokir rekaman baru bila penyimpanan lokal gagal.

Rekaman yang terputus karena tab ditutup, kamera gagal, atau batas durasi tercapai diberi penanda **TERPUTUS**, bukan dianggap bukti lengkap. Potongan terakhir sebelum gangguan mungkin belum tersimpan. Periksa dan unggah secara manual bila masih berguna, lalu rekam ulang bila perlu. Batas durasi dapat diubah admin (30–600 detik); bila packing belum selesai, lanjutkan dengan rekaman baru pada resi yang sama.

## 6. Cari video saat ada komplain

Admin membuka **Admin → Cari resi**, memasukkan resi atau nomor pesanan, lalu membuka video terkait. Google Drive dapat memerlukan waktu untuk memproses video sebelum pemutaran. Masuk ke akun Google pemilik/akun yang diberi akses folder untuk memutar atau mengunduh video. Aplikasi tidak mengubah file menjadi publik secara otomatis.

Tidak ada penghapusan video otomatis. Kapasitas Drive, retensi bukti, dan siapa yang boleh mengakses folder dikelola oleh pemilik akun. Cadangkan rekaman yang sedang terkait komplain sesuai kebutuhan usaha.

## Validasi pengembangan

Jalankan tes logika dengan Node.js 18+:

```sh
node --test tests/*.test.cjs
```

Tes browser menggunakan Python Playwright dan Chromium:

```sh
python tests/recording-browser.py
python tests/fulfillment-browser.py
```

Tes backend memakai model layanan Apps Script di memori. Tes antrean memakai IndexedDB nyata dengan perekam sintetis untuk menguji gangguan secara deterministik; tes antarmuka memakai browser dan kamera virtual. Layanan Google dan RPC dimodelkan dalam tes, tanpa mengubah pesanan atau Drive produksi. Setelah deploy, lakukan satu impor contoh, satu pengecekan picker, dan satu rekaman pendek untuk membuktikan izin, upload, serta pemutaran Drive bekerja pada akun dan perangkat sebenarnya.
