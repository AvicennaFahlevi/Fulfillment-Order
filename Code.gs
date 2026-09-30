/**
 * PACKING RECORDER
 * Rekam video proses packing per nomor resi, simpan ke Google Drive,
 * catat ke Google Sheets, dan tarik data pesanan dari Shopee.
 *
 * Langkah pertama: jalankan fungsi setup() sekali dari editor Apps Script.
 */

const APP = { NAME: 'Meirista Fulfillment', TZ: 'Asia/Jakarta' };

const SHEETS = {
  RECORDS: {
    name: 'Records',
    headers: ['Record ID', 'No. Resi', 'No. Pesanan', 'Packer ID', 'Nama Packer', 'Stasiun',
      'Mulai', 'Selesai', 'Durasi (detik)', 'Video File ID', 'Link Video', 'Ukuran (MB)', 'Status', 'Catatan'],
    textCols: [2, 3, 4]
  },
  PACKERS: {
    name: 'Packers',
    headers: ['Packer ID', 'Nama', 'Kode Badge', 'Aktif', 'Dibuat'],
    textCols: [1, 3]
  },
  ORDERS: {
    name: 'Orders',
    headers: ['No. Resi', 'No. Pesanan', 'Username Pembeli', 'Nama Penerima', 'Status Pesanan',
      'Item (JSON)', 'Ringkasan Item', 'Sumber', 'Diperbarui'],
    textCols: [1, 2]
  },
  LOG: { name: 'Log', headers: ['Waktu', 'Jenis', 'Pesan'], textCols: [] }
};

const REC = { ID: 0, RESI: 1, SN: 2, PID: 3, PNAME: 4, STATION: 5, START: 6, END: 7, DUR: 8, FILE: 9, LINK: 10, MB: 11, STATUS: 12, NOTE: 13 };
const PROP = PropertiesService.getScriptProperties();
const SKIP_STATUSES = ['UNPAID', 'CANCELLED', 'IN_CANCEL'];

/* ============================== SETUP ============================== */

function setup() {
  let ss;
  const ssId = PROP.getProperty('SS_ID');
  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.create('Meirista Fulfillment - Database');
    PROP.setProperty('SS_ID', ss.getId());
  }
  ss.setSpreadsheetTimeZone(APP.TZ);
  Object.keys(SHEETS).forEach(k => ensureSheet_(ss, SHEETS[k]));
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('Sheet 1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);

  if (!PROP.getProperty('VIDEO_FOLDER_ID')) {
    const folder = DriveApp.createFolder('Meirista Fulfillment - Video');
    PROP.setProperty('VIDEO_FOLDER_ID', folder.getId());
  }
  if (!PROP.getProperty('ADMIN_PIN_HASH')) setPinHash_('123456');
  if (!PROP.getProperty('STATION_KEY')) PROP.setProperty('STATION_KEY', Utilities.getUuid().replace(/-/g, ''));
  if (!PROP.getProperty('MAX_SEC')) PROP.setProperty('MAX_SEC', '180');
  if (!PROP.getProperty('BITRATE')) PROP.setProperty('BITRATE', '700000');
  if (!PROP.getProperty('SHOPEE_ENV')) PROP.setProperty('SHOPEE_ENV', 'live');
  if (!PROP.getProperty('SYNC_DAYS')) PROP.setProperty('SYNC_DAYS', '3');

  Logger.log('Database : ' + ss.getUrl());
  Logger.log('Folder video : https://drive.google.com/drive/folders/' + PROP.getProperty('VIDEO_FOLDER_ID'));
  Logger.log('PIN admin awal: 123456 (segera ganti di menu Pengaturan)');
  Logger.log('Kunci stasiun (Station Key): ' + PROP.getProperty('STATION_KEY'));
  Logger.log('Deploy sebagai Web App (Execute as: Me, Who has access: Anyone), lalu masukkan URL /exec dan kunci ini ke halaman stasiun.');
}

function ensureSheet_(ss, def) {
  let sh = ss.getSheetByName(def.name);
  if (!sh) sh = ss.insertSheet(def.name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers])
      .setFontWeight('bold').setBackground('#16222E').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  def.textCols.forEach(c => sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@'));
  return sh;
}

function ss_() {
  const id = PROP.getProperty('SS_ID');
  if (!id) throw new Error('Aplikasi belum di-setup. Jalankan fungsi setup() di editor Apps Script.');
  return SpreadsheetApp.openById(id);
}

function sheet_(key) {
  const def = SHEETS[key];
  const sh = ss_().getSheetByName(def.name);
  return sh || ensureSheet_(ss_(), def);
}

/* ============================== WEB APP ============================== */

/**
 * Semua panggilan dari halaman kamera (di luar Apps Script) lewat sini,
 * sebagai satu RPC ber-JSON. Dikirim sebagai POST text/plain (bukan
 * application/json) supaya browser tidak melakukan preflight CORS,
 * yang tidak didukung Apps Script.
 * Body: {"key": "...", "fn": "namaFungsi", "args": [...]}
 */
const RPC_ALLOWED = [
  'getBootstrap', 'lookupResi', 'startVideoUpload', 'uploadVideoChunk', 'saveRecord',
  'adminLogin', 'adminDashboard', 'adminSearch', 'adminGetPackers', 'adminSavePacker',
  'listOrders', 'adminImportOrders', 'adminGetSettings', 'adminSaveSettings', 'adminShopeeAuthUrl',
  'adminShopeeSync', 'adminSetAutoSync', 'adminRotateStationKey'
];

function doPost(e) {
  let body = {};
  let out;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.key !== PROP.getProperty('STATION_KEY')) throw new Error('Kunci stasiun salah atau kedaluwarsa.');
    if (RPC_ALLOWED.indexOf(body.fn) < 0) throw new Error('Fungsi tidak dikenal: ' + body.fn);
    const args = Array.isArray(body.args) ? body.args : [];
    const fn = globalThis[body.fn];
    if (typeof fn !== 'function') throw new Error('Fungsi tidak tersedia: ' + body.fn);
    out = { ok: true, result: fn.apply(null, args) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.code && p.shop_id) return shopeeCallback_(p);
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP.NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Data awal untuk stasiun packing. */
function getBootstrap() {
  return {
    packers: readPackers_().filter(p => p.active).map(p => ({ id: p.id, name: p.name, code: p.code })),
    maxSec: Number(PROP.getProperty('MAX_SEC') || 180),
    bitrate: Number(PROP.getProperty('BITRATE') || 700000),
    shopeeConnected: shopeeConnected_()
  };
}

/** Dipanggil stasiun saat resi di-scan: isi pesanan + riwayat rekaman resi itu. */
function lookupResi(resiRaw) {
  const resi = cleanResi_(resiRaw);
  if (!resi) return { order: null, history: [] };
  const history = findRecordRows_(resi, REC.RESI + 1).map(r => ({
    startAt: iso_(r[REC.START]), packerName: r[REC.PNAME], station: r[REC.STATION]
  }));
  return { order: findOrder_(resi), history: history };
}

/* ============================== UPLOAD VIDEO ============================== */

/** Membuka sesi resumable upload ke Google Drive. Token OAuth tidak pernah dikirim ke browser. */
function startVideoUpload(meta) {
  const resi = cleanResi_(meta.resi);
  if (!resi) throw new Error('Nomor resi tidak valid.');
  const mime = (meta.mime === 'video/mp4') ? 'video/mp4' : 'video/webm';
  const size = Number(meta.size);
  if (!(size > 0) || size > 200 * 1024 * 1024) throw new Error('Ukuran video tidak valid.');

  const start = new Date(meta.startAt);
  const folderId = monthFolderId_(start);
  const name = [resi, Utilities.formatDate(start, APP.TZ, 'yyyyMMdd-HHmmss'), safeName_(meta.packerName || '')]
    .filter(String).join('_') + (mime === 'video/mp4' ? '.mp4' : '.webm');

  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(size)
    },
    payload: JSON.stringify({ name: name, parents: [folderId], mimeType: mime }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Drive menolak upload: ' + res.getContentText().slice(0, 200));
  const h = res.getHeaders();
  const session = h.Location || h.location;
  if (!session) throw new Error('Drive tidak mengembalikan alamat upload.');

  const uploadId = Utilities.getUuid();
  putUpload_(uploadId, { session: session, mime: mime, size: size, name: name, fileId: '', recordId: '' });
  return { uploadId: uploadId };
}

/** Mengirim satu potongan video (base64). Potongan selain terakhir harus kelipatan 256 KB. */
function uploadVideoChunk(uploadId, b64, start) {
  const up = getUpload_(uploadId);
  if (!up) throw new Error('Sesi upload kedaluwarsa. Ulangi upload.');
  if (up.fileId) return { done: true };
  const bytes = Utilities.base64Decode(b64);
  const end = Number(start) + bytes.length - 1;
  const res = UrlFetchApp.fetch(up.session, {
    method: 'put',
    contentType: up.mime,
    payload: bytes,
    headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + up.size },
    muteHttpExceptions: true,
    followRedirects: false
  });
  const code = res.getResponseCode();
  if (code === 308) {
    const h = res.getHeaders();
    const range = h.Range || h.range || '';
    const m = /bytes=0-(\d+)/.exec(range);
    return { done: false, next: m ? Number(m[1]) + 1 : 0 };
  }
  if (code === 200 || code === 201) {
    up.fileId = JSON.parse(res.getContentText()).id;
    putUpload_(uploadId, up);
    return { done: true };
  }
  throw new Error('Upload potongan gagal (' + code + '): ' + res.getContentText().slice(0, 200));
}

/** Mencatat hasil packing ke sheet Records. Idempoten per uploadId. */
function saveRecord(rec) {
  const up = rec.uploadId ? getUpload_(rec.uploadId) : null;
  if (rec.uploadId && (!up || !up.fileId)) throw new Error('Video belum selesai terunggah.');
  if (up && up.recordId) return { recordId: up.recordId };

  const resi = cleanResi_(rec.resi);
  if (!resi) throw new Error('Nomor resi tidak valid.');
  const packer = readPackers_().filter(p => p.id === rec.packerId)[0];
  const order = findOrder_(resi);
  const start = new Date(rec.startAt);
  const end = new Date(rec.endAt);
  const id = 'REC-' + Utilities.formatDate(start, APP.TZ, 'yyyyMMddHHmmss') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

  const row = [
    id, resi, order ? order.orderSn : '', rec.packerId || '', packer ? packer.name : (rec.packerName || ''),
    String(rec.station || '').slice(0, 40), start, end, Math.max(0, Math.round((end - start) / 1000)),
    up ? up.fileId : '', up ? 'https://drive.google.com/file/d/' + up.fileId + '/view' : '',
    up ? Math.round(up.size / 1048576 * 100) / 100 : '', up ? 'OK' : 'TANPA VIDEO', String(rec.note || '').slice(0, 300)
  ];

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sheet_('RECORDS').appendRow(row);
  } finally {
    lock.releaseLock();
  }
  if (up) { up.recordId = id; putUpload_(rec.uploadId, up); }
  return { recordId: id };
}

function putUpload_(id, obj) { CacheService.getScriptCache().put('up_' + id, JSON.stringify(obj), 21600); }
function getUpload_(id) {
  const raw = CacheService.getScriptCache().get('up_' + id);
  return raw ? JSON.parse(raw) : null;
}

function monthFolderId_(date) {
  const ym = Utilities.formatDate(date, APP.TZ, 'yyyy-MM');
  const key = 'FOLDER_' + ym;
  const cached = PROP.getProperty(key);
  if (cached) return cached;
  const root = DriveApp.getFolderById(PROP.getProperty('VIDEO_FOLDER_ID'));
  const it = root.getFoldersByName(ym);
  const folder = it.hasNext() ? it.next() : root.createFolder(ym);
  PROP.setProperty(key, folder.getId());
  return folder.getId();
}

/* ============================== ADMIN ============================== */

function adminLogin(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pin_fail') || 0);
  if (fails >= 5) throw new Error('Terlalu banyak percobaan. Coba lagi 10 menit lagi.');
  if (hash_(String(pin || '')) !== PROP.getProperty('ADMIN_PIN_HASH')) {
    cache.put('pin_fail', String(fails + 1), 600);
    throw new Error('PIN salah.');
  }
  cache.remove('pin_fail');
  const token = Utilities.getUuid();
  cache.put('adm_' + token, '1', 21600);
  return token;
}

function requireAdmin_(token) {
  if (!token || !CacheService.getScriptCache().get('adm_' + token)) throw new Error('SESSION: Sesi admin berakhir. Masuk lagi dengan PIN.');
}

/** Semua rekaman pada satu tanggal (yyyy-MM-dd, WIB). */
function adminDashboard(token, dateStr) {
  requireAdmin_(token);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('Format tanggal tidak valid.');
  const from = new Date(dateStr + 'T00:00:00+07:00').getTime();
  const to = from + 86400000;
  const sh = sheet_('RECORDS');
  const last = sh.getLastRow();
  if (last < 2) return { date: dateStr, records: [] };

  const starts = sh.getRange(2, REC.START + 1, last - 1, 1).getValues();
  let lo = -1, hi = -1;
  for (let i = 0; i < starts.length; i++) {
    const d = starts[i][0];
    if (d instanceof Date && d.getTime() >= from && d.getTime() < to) {
      if (lo < 0) lo = i;
      hi = i;
    }
  }
  if (lo < 0) return { date: dateStr, records: [] };
  const rows = sh.getRange(2 + lo, 1, hi - lo + 1, SHEETS.RECORDS.headers.length).getValues();
  const records = rows
    .filter(r => r[REC.START] instanceof Date && r[REC.START].getTime() >= from && r[REC.START].getTime() < to)
    .map(recToObj_)
    .sort((a, b) => b.startAt.localeCompare(a.startAt));
  return { date: dateStr, records: records };
}

/** Cari berdasarkan no. resi atau no. pesanan. */
function adminSearch(token, q) {
  requireAdmin_(token);
  const key = cleanResi_(q);
  if (!key) throw new Error('Masukkan nomor resi atau nomor pesanan.');
  let order = findOrder_(key) || findOrderBySn_(key);
  let rows = findRecordRows_(key, REC.RESI + 1);
  if (!rows.length) rows = findRecordRows_(key, REC.SN + 1);
  if (!rows.length && order) rows = findRecordRows_(order.resi, REC.RESI + 1);
  if (!order && rows.length) order = findOrder_(rows[0][REC.RESI]);
  return {
    query: key,
    order: order,
    records: rows.map(recToObj_).sort((a, b) => b.startAt.localeCompare(a.startAt))
  };
}

function adminGetPackers(token) {
  requireAdmin_(token);
  return readPackers_();
}

function adminSavePacker(token, p) {
  requireAdmin_(token);
  const name = String(p.name || '').trim().slice(0, 60);
  const code = String(p.code || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 30);
  if (!name) throw new Error('Nama packer wajib diisi.');
  if (!/^[A-Z0-9\-_.]{3,30}$/.test(code)) throw new Error('Kode badge 3–30 karakter: huruf, angka, - _ .');
  if (['STOP', 'SELESAI'].indexOf(code) >= 0) throw new Error('Kode itu dipakai untuk barcode STOP.');

  const sh = sheet_('PACKERS');
  const list = readPackers_();
  if (list.some(x => x.code === code && x.id !== p.id)) throw new Error('Kode badge ' + code + ' sudah dipakai.');

  if (p.id) {
    const idx = list.findIndex(x => x.id === p.id);
    if (idx < 0) throw new Error('Packer tidak ditemukan.');
    sh.getRange(idx + 2, 2, 1, 3).setValues([[name, code, p.active !== false]]);
  } else {
    const id = 'P' + Date.now().toString(36).toUpperCase();
    sh.appendRow([id, name, code, true, new Date()]);
  }
  return readPackers_();
}

function readPackers_() {
  const sh = sheet_('PACKERS');
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 4).getValues()
    .filter(r => r[0])
    .map(r => ({ id: String(r[0]), name: String(r[1]), code: String(r[2]).toUpperCase(), active: r[3] === true || String(r[3]).toUpperCase() === 'TRUE' }));
}

/** Import hasil ekspor pesanan Shopee (sudah dikelompokkan per resi di browser). Dipakai menu Pesanan. */
function importOrders(orders) {
  if (!Array.isArray(orders) || orders.length > 500) throw new Error('Kirim maksimal 500 pesanan per batch.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return { saved: upsertOrders_(orders, 'Import file') };
  } finally {
    lock.releaseLock();
  }
}

function adminImportOrders(token, orders) {
  requireAdmin_(token);
  return importOrders(orders);
}

/**
 * Daftar pesanan untuk menu Pesanan, terbaru dulu, dilengkapi status packing.
 * opts: { q: teks cari (resi / no. pesanan / pembeli / penerima), limit, resi: [daftar resi dari file yang baru diunggah] }
 */
function listOrders(opts) {
  opts = opts || {};
  const limit = clamp_(parseInt(opts.limit, 10) || 300, 1, 1000);
  const q = String(opts.q || '').trim().toUpperCase();
  let only = null;
  if (Array.isArray(opts.resi) && opts.resi.length) {
    only = {};
    opts.resi.slice(0, 2000).forEach(r => { const c = cleanResi_(r); if (c) only[c] = true; });
  }
  const sh = sheet_('ORDERS');
  const last = sh.getLastRow();
  if (last < 2) return { total: 0, orders: [] };
  const width = SHEETS.ORDERS.headers.length;

  let rows;
  if (!q && !only) {
    const n = Math.min(limit, last - 1);
    rows = sh.getRange(last - n + 1, 1, n, width).getValues();
  } else {
    rows = sh.getRange(2, 1, last - 1, width).getValues().filter(r => {
      if (only && !only[String(r[0]).toUpperCase()]) return false;
      if (!q) return true;
      return [r[0], r[1], r[2], r[3]].join(' ').toUpperCase().indexOf(q) >= 0;
    }).slice(-limit);
  }
  rows.reverse();

  const packed = packedMap_();
  const orders = rows.map(r => {
    let items = [];
    try { items = JSON.parse(r[5] || '[]'); } catch (e) { items = []; }
    const pk = packed[String(r[0]).toUpperCase()];
    return {
      resi: String(r[0]), orderSn: String(r[1]), buyer: String(r[2]), recipient: String(r[3]), status: String(r[4]),
      items: items, totalQty: items.reduce((t, it) => t + (Number(it.qty) || 0), 0),
      source: String(r[7]), updatedAt: iso_(r[8]),
      packed: pk ? { count: pk.count, lastAt: pk.lastAt ? new Date(pk.lastAt).toISOString() : '', lastPacker: pk.lastPacker, hasVideo: pk.hasVideo } : null
    };
  });
  return { total: last - 1, orders: orders };
}

/** Resi -> ringkasan rekaman packing (jumlah, terakhir kapan, oleh siapa). */
function packedMap_() {
  const sh = sheet_('RECORDS');
  const last = sh.getLastRow();
  const map = {};
  if (last < 2) return map;
  // Kolom B..M: 0 resi, 3 nama packer, 5 mulai, 11 status
  sh.getRange(2, 2, last - 1, 12).getValues().forEach(r => {
    const resi = String(r[0]).toUpperCase();
    if (!resi) return;
    const t = r[5] instanceof Date ? r[5].getTime() : 0;
    const m = map[resi] || (map[resi] = { count: 0, lastAt: 0, lastPacker: '', hasVideo: false });
    m.count++;
    if (t >= m.lastAt) { m.lastAt = t; m.lastPacker = String(r[3]); }
    if (r[11] === 'OK') m.hasVideo = true;
  });
  return map;
}

function adminGetSettings(token) {
  requireAdmin_(token);
  const exp = Number(PROP.getProperty('SHOPEE_TOKEN_EXPIRE') || 0);
  return {
    maxSec: Number(PROP.getProperty('MAX_SEC') || 180),
    bitrate: Number(PROP.getProperty('BITRATE') || 700000),
    syncDays: Number(PROP.getProperty('SYNC_DAYS') || 3),
    sheetUrl: ss_().getUrl(),
    folderUrl: 'https://drive.google.com/drive/folders/' + PROP.getProperty('VIDEO_FOLDER_ID'),
    webAppUrl: ScriptApp.getService().getUrl(),
    stationKey: PROP.getProperty('STATION_KEY'),
    shopee: {
      env: PROP.getProperty('SHOPEE_ENV') || 'live',
      partnerId: PROP.getProperty('SHOPEE_PARTNER_ID') || '',
      hasKey: !!PROP.getProperty('SHOPEE_PARTNER_KEY'),
      shopId: PROP.getProperty('SHOPEE_SHOP_ID') || '',
      connected: shopeeConnected_(),
      refreshExpire: PROP.getProperty('SHOPEE_REFRESH_EXPIRE') || '',
      tokenExpire: exp ? new Date(exp * 1000).toISOString() : '',
      lastSync: PROP.getProperty('SHOPEE_LAST_SYNC') || '',
      lastSyncMsg: PROP.getProperty('SHOPEE_LAST_SYNC_MSG') || '',
      autoSync: ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'syncShopeeOrders')
    }
  };
}

function adminSaveSettings(token, s) {
  requireAdmin_(token);
  if (s.maxSec !== undefined) PROP.setProperty('MAX_SEC', String(clamp_(parseInt(s.maxSec, 10) || 180, 30, 600)));
  if (s.bitrate !== undefined) PROP.setProperty('BITRATE', String(clamp_(parseInt(s.bitrate, 10) || 700000, 300000, 2000000)));
  if (s.syncDays !== undefined) PROP.setProperty('SYNC_DAYS', String(clamp_(parseInt(s.syncDays, 10) || 3, 1, 15)));
  if (s.env === 'live' || s.env === 'sandbox') PROP.setProperty('SHOPEE_ENV', s.env);
  if (s.partnerId !== undefined) PROP.setProperty('SHOPEE_PARTNER_ID', String(s.partnerId).replace(/\D/g, ''));
  if (s.partnerKey) PROP.setProperty('SHOPEE_PARTNER_KEY', String(s.partnerKey).trim());
  if (s.newPin) {
    if (!/^\d{4,8}$/.test(s.newPin)) throw new Error('PIN harus 4–8 angka.');
    setPinHash_(s.newPin);
  }
  return adminGetSettings(token);
}

/** Mengganti kunci stasiun. Semua halaman kamera yang sudah terpasang perlu diperbarui kuncinya setelah ini. */
function adminRotateStationKey(token) {
  requireAdmin_(token);
  PROP.setProperty('STATION_KEY', Utilities.getUuid().replace(/-/g, ''));
  return adminGetSettings(token);
}

function adminShopeeAuthUrl(token) {
  requireAdmin_(token);
  const pid = PROP.getProperty('SHOPEE_PARTNER_ID');
  if (!pid || !PROP.getProperty('SHOPEE_PARTNER_KEY')) throw new Error('Isi Partner ID dan Partner Key dulu, lalu simpan.');
  const path = '/api/v2/shop/auth_partner';
  const ts = nowSec_();
  const redirect = ScriptApp.getService().getUrl();
  return shopeeHost_() + path + '?partner_id=' + pid + '&timestamp=' + ts +
    '&sign=' + sign_(pid + path + ts) + '&redirect=' + encodeURIComponent(redirect);
}

function adminShopeeSync(token) {
  requireAdmin_(token);
  return syncShopeeOrders();
}

function adminSetAutoSync(token, on) {
  requireAdmin_(token);
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncShopeeOrders')
    .forEach(t => ScriptApp.deleteTrigger(t));
  if (on) ScriptApp.newTrigger('syncShopeeOrders').timeBased().everyMinutes(30).create();
  return adminGetSettings(token);
}

/* ============================== SHOPEE OPEN PLATFORM v2 ============================== */

function shopeeHost_() {
  return PROP.getProperty('SHOPEE_ENV') === 'sandbox'
    ? 'https://partner.test-stable.shopeemobile.com'
    : 'https://partner.shopeemobile.com';
}

function sign_(base) {
  const raw = Utilities.computeHmacSha256Signature(base, PROP.getProperty('SHOPEE_PARTNER_KEY'));
  return raw.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function shopeeConnected_() {
  return !!(PROP.getProperty('SHOPEE_REFRESH_TOKEN') && PROP.getProperty('SHOPEE_SHOP_ID'));
}

function shopeeCallback_(p) {
  let msg;
  try {
    const pid = PROP.getProperty('SHOPEE_PARTNER_ID');
    const json = shopeePublicPost_('/api/v2/auth/token/get', {
      code: String(p.code), shop_id: Number(p.shop_id), partner_id: Number(pid)
    });
    PROP.setProperty('SHOPEE_SHOP_ID', String(p.shop_id));
    storeTokens_(json);
    msg = 'Toko Shopee (shop ID ' + p.shop_id + ') berhasil terhubung. Tutup tab ini dan kembali ke aplikasi.';
  } catch (err) {
    msg = 'Gagal menghubungkan toko: ' + err.message;
  }
  return HtmlService.createHtmlOutput('<div style="font:16px/1.5 sans-serif;max-width:560px;margin:48px auto;padding:0 16px">' +
    '<h2>' + APP.NAME + '</h2><p>' + escapeHtml_(msg) + '</p></div>').setTitle(APP.NAME);
}

function storeTokens_(json) {
  PROP.setProperty('SHOPEE_ACCESS_TOKEN', json.access_token);
  PROP.setProperty('SHOPEE_REFRESH_TOKEN', json.refresh_token);
  PROP.setProperty('SHOPEE_TOKEN_EXPIRE', String(nowSec_() + Number(json.expire_in || 14400)));
  PROP.setProperty('SHOPEE_REFRESH_EXPIRE', new Date(Date.now() + 30 * 86400000).toISOString());
}

function shopeePublicPost_(path, body) {
  const pid = PROP.getProperty('SHOPEE_PARTNER_ID');
  const ts = nowSec_();
  const url = shopeeHost_() + path + '?partner_id=' + pid + '&timestamp=' + ts + '&sign=' + sign_(pid + path + ts);
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText() || '{}');
  if (json.error) throw new Error(json.error + ': ' + (json.message || ''));
  return json;
}

function accessToken_() {
  const exp = Number(PROP.getProperty('SHOPEE_TOKEN_EXPIRE') || 0);
  if (exp - nowSec_() > 300) return PROP.getProperty('SHOPEE_ACCESS_TOKEN');
  const json = shopeePublicPost_('/api/v2/auth/access_token/get', {
    refresh_token: PROP.getProperty('SHOPEE_REFRESH_TOKEN'),
    shop_id: Number(PROP.getProperty('SHOPEE_SHOP_ID')),
    partner_id: Number(PROP.getProperty('SHOPEE_PARTNER_ID'))
  });
  storeTokens_(json);
  return json.access_token;
}

function shopeeGet_(path, params) {
  const pid = PROP.getProperty('SHOPEE_PARTNER_ID');
  const shopId = PROP.getProperty('SHOPEE_SHOP_ID');
  const token = accessToken_();
  const ts = nowSec_();
  const q = {
    partner_id: pid, timestamp: ts, access_token: token, shop_id: shopId,
    sign: sign_(pid + path + ts + token + shopId)
  };
  Object.keys(params || {}).forEach(k => { q[k] = params[k]; });
  const qs = Object.keys(q).map(k => k + '=' + encodeURIComponent(q[k])).join('&');
  const res = UrlFetchApp.fetch(shopeeHost_() + path + '?' + qs, { method: 'get', muteHttpExceptions: true });
  const json = JSON.parse(res.getContentText() || '{}');
  if (json.error) throw new Error(path + ' → ' + json.error + ': ' + (json.message || ''));
  return json.response || {};
}

/**
 * Tarik pesanan yang berubah dalam N hari terakhir, ambil nomor resinya,
 * lalu simpan ke sheet Orders. Bisa dijalankan dari tombol admin atau trigger 30 menit.
 */
function syncShopeeOrders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'Sinkronisasi lain sedang berjalan.';
  const t0 = Date.now();
  let msg;
  try {
    if (!shopeeConnected_()) throw new Error('Toko Shopee belum terhubung.');
    const days = Number(PROP.getProperty('SYNC_DAYS') || 3);
    const to = nowSec_();
    const from = to - days * 86400;

    const sns = [];
    let cursor = '', more = true, guard = 0;
    while (more && guard++ < 100) {
      const r = shopeeGet_('/api/v2/order/get_order_list', {
        time_range_field: 'update_time', time_from: from, time_to: to, page_size: 100, cursor: cursor
      });
      (r.order_list || []).forEach(o => sns.push(o.order_sn));
      more = !!r.more;
      cursor = r.next_cursor || '';
    }

    const known = ordersBySn_();
    const todo = sns.filter(sn => !known[sn]);
    let saved = 0, noResi = 0, stopped = false;

    for (let i = 0; i < todo.length; i += 50) {
      if (Date.now() - t0 > 270000) { stopped = true; break; }
      const d = shopeeGet_('/api/v2/order/get_order_detail', {
        order_sn_list: todo.slice(i, i + 50).join(','),
        response_optional_fields: 'buyer_username,recipient_address,item_list'
      });
      const out = [];
      (d.order_list || []).forEach(o => {
        if (SKIP_STATUSES.indexOf(o.order_status) >= 0) return;
        let resi = '';
        try {
          resi = shopeeGet_('/api/v2/logistics/get_tracking_number', { order_sn: o.order_sn }).tracking_number || '';
        } catch (e) { /* resi belum terbit */ }
        if (!resi) { noResi++; return; }
        out.push({
          resi: resi,
          orderSn: o.order_sn,
          buyer: o.buyer_username || '',
          recipient: (o.recipient_address && o.recipient_address.name) || '',
          status: o.order_status || '',
          items: (o.item_list || []).map(it => ({
            name: it.item_name || '',
            variation: it.model_name || '',
            sku: it.model_sku || it.item_sku || '',
            qty: Number(it.model_quantity_purchased || 0)
          }))
        });
      });
      saved += upsertOrders_(out, 'Shopee API');
    }
    msg = 'Berhasil: ' + saved + ' pesanan baru disimpan, ' + noResi + ' belum punya resi' +
      (stopped ? ', sisanya diproses pada sinkronisasi berikutnya.' : '.');
  } catch (err) {
    msg = 'Gagal: ' + err.message;
    log_('SHOPEE', msg);
  } finally {
    PROP.setProperty('SHOPEE_LAST_SYNC', new Date().toISOString());
    PROP.setProperty('SHOPEE_LAST_SYNC_MSG', msg || '');
    lock.releaseLock();
  }
  return msg;
}

/* ============================== ORDERS ============================== */

function upsertOrders_(orders, source) {
  if (!orders || !orders.length) return 0;
  const sh = sheet_('ORDERS');
  const last = sh.getLastRow();
  const idx = {};
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 2).getValues().forEach((r, i) => {
      if (r[0]) idx['R:' + String(r[0]).toUpperCase()] = i + 2;
      if (r[1]) idx['S:' + String(r[1])] = i + 2;
    });
  }
  const now = new Date();
  const appends = [];
  let count = 0;
  orders.forEach(o => {
    const resi = cleanResi_(o.resi);
    if (!resi) return;
    const items = (o.items || []).slice(0, 100).map(it => ({
      name: String(it.name || '').slice(0, 200), variation: String(it.variation || '').slice(0, 120),
      sku: String(it.sku || '').slice(0, 80), qty: Number(it.qty) || 0
    }));
    const summary = items.map(it => it.qty + 'x ' + it.name + (it.variation ? ' (' + it.variation + ')' : '')).join(' | ');
    const sn = String(o.orderSn || '').trim();
    const row = [resi, sn, String(o.buyer || ''), String(o.recipient || ''), String(o.status || ''),
      JSON.stringify(items), summary, source, now];
    const at = idx['R:' + resi] || (sn && idx['S:' + sn]);
    if (at > 0) {
      sh.getRange(at, 1, 1, row.length).setValues([row]);
    } else if (at !== -1) {
      appends.push(row);
      idx['R:' + resi] = -1;
    }
    count++;
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, appends[0].length).setValues(appends);
  return count;
}

function ordersBySn_() {
  const sh = sheet_('ORDERS');
  const last = sh.getLastRow();
  const map = {};
  if (last > 1) sh.getRange(2, 1, last - 1, 2).getValues().forEach(r => { if (r[1] && r[0]) map[String(r[1])] = true; });
  return map;
}

function findOrder_(resi) { return findOrderIn_(resi, 1); }
function findOrderBySn_(sn) { return findOrderIn_(sn, 2); }

function findOrderIn_(value, col) {
  const sh = sheet_('ORDERS');
  const last = sh.getLastRow();
  if (last < 2 || !value) return null;
  const hit = sh.getRange(2, col, last - 1, 1).createTextFinder(String(value)).matchEntireCell(true).matchCase(false).findNext();
  if (!hit) return null;
  const r = sh.getRange(hit.getRow(), 1, 1, SHEETS.ORDERS.headers.length).getValues()[0];
  let items = [];
  try { items = JSON.parse(r[5] || '[]'); } catch (e) { items = []; }
  return {
    resi: String(r[0]), orderSn: String(r[1]), buyer: String(r[2]), recipient: String(r[3]),
    status: String(r[4]), items: items, source: String(r[7]), updatedAt: iso_(r[8])
  };
}

/* ============================== RECORDS HELPERS ============================== */

function findRecordRows_(value, col) {
  const sh = sheet_('RECORDS');
  const last = sh.getLastRow();
  if (last < 2 || !value) return [];
  const hits = sh.getRange(2, col, last - 1, 1).createTextFinder(String(value)).matchEntireCell(true).matchCase(false).findAll();
  return hits.slice(-50).map(h => sh.getRange(h.getRow(), 1, 1, SHEETS.RECORDS.headers.length).getValues()[0]);
}

function recToObj_(r) {
  return {
    id: String(r[REC.ID]), resi: String(r[REC.RESI]), orderSn: String(r[REC.SN]),
    packerId: String(r[REC.PID]), packerName: String(r[REC.PNAME]), station: String(r[REC.STATION]),
    startAt: iso_(r[REC.START]), endAt: iso_(r[REC.END]), durationSec: Number(r[REC.DUR]) || 0,
    fileId: String(r[REC.FILE]), sizeMb: Number(r[REC.MB]) || 0, status: String(r[REC.STATUS]), note: String(r[REC.NOTE])
  };
}

/* ============================== UTIL ============================== */

function cleanResi_(v) {
  const s = String(v || '').replace(/\s+/g, '').toUpperCase().slice(0, 64);
  return /^[A-Z0-9\-_.]{5,64}$/.test(s) ? s : '';
}
function safeName_(s) { return String(s).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40); }
function iso_(d) { return d instanceof Date ? d.toISOString() : (d ? String(d) : ''); }
function nowSec_() { return Math.floor(Date.now() / 1000); }
function clamp_(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function hash_(s) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'packing-recorder:' + s);
  return raw.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function setPinHash_(pin) { PROP.setProperty('ADMIN_PIN_HASH', hash_(String(pin))); }
function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function log_(type, msg) {
  try { sheet_('LOG').appendRow([new Date(), type, String(msg).slice(0, 1000)]); } catch (e) { /* abaikan */ }
}