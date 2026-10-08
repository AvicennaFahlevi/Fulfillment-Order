const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

// In-memory Apps Script services: tests never contact Sheets, Drive or Shopee.
function backend() {
  const props = new Map([['ADMIN_INITIAL_PIN', '764321'], ['STATION_KEY', 'station-test-key']]);
  const cache = new Map(), sheets = new Map(), requests = [], responses = [];
  let folderId = 0, lockDepth = 0;
  class Range {
    constructor(sheet, row, col, height = 1, width = 1) { Object.assign(this, { sheet, row, col, height, width }); }
    getValues() { return Array.from({ length: this.height }, (_, r) => Array.from({ length: this.width }, (_, c) => this.sheet.rows[this.row + r - 1]?.[this.col + c - 1] ?? '')); }
    setValues(values) {
      assert.equal(values.length, this.height);
      values.forEach((row, r) => {
        assert.equal(row.length, this.width);
        const dest = this.sheet.rows[this.row + r - 1] ||= [];
        row.forEach((value, c) => { dest[this.col + c - 1] = value; });
      });
      return this;
    }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setFontColor() { return this; }
    setNumberFormat() { return this; }
    createTextFinder(value) {
      let exact = false, sensitive = false;
      const find = () => {
        const hits = [];
        this.getValues().forEach((row, r) => row.forEach(cell => {
          const left = sensitive ? String(cell) : String(cell).toLowerCase();
          const right = sensitive ? String(value) : String(value).toLowerCase();
          if (exact ? left === right : left.includes(right)) hits.push({ getRow: () => this.row + r });
        }));
        return hits;
      };
      return { matchEntireCell(v) { exact = v; return this; }, matchCase(v) { sensitive = v; return this; }, findNext: () => find()[0] || null, findAll: find };
    }
  }
  class Sheet {
    constructor(name) { this.name = name; this.rows = []; }
    getRange(...args) { return new Range(this, ...args); }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
    getMaxRows() { return 1000; }
    setFrozenRows() {}
    appendRow(row) { this.rows.push([...row]); return this; }
  }
  const ss = {
    getId: () => 'test-spreadsheet', getUrl: () => 'https://docs.google.com/spreadsheets/d/test',
    setSpreadsheetTimeZone() {}, getSheets: () => [...sheets.values()],
    getSheetByName: name => sheets.get(name),
    insertSheet(name) { const sh = new Sheet(name); sheets.set(name, sh); return sh; },
    deleteSheet(sh) { sheets.delete(sh.name); }
  };
  const folder = () => ({ getId: () => 'test-folder-' + (++folderId), getFoldersByName: () => ({ hasNext: () => false }), createFolder: folder });
  const context = vm.createContext({
    Date, Set, Number, JSON, String, Math, Object, Array,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key) ?? null, setProperty(key, value) { props.set(key, String(value)); }, deleteProperty: key => props.delete(key), getKeys: () => [...props.keys()] }) },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key) ?? null, put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(lockDepth++, 0, 'Locks cannot nest'); }, releaseLock() { assert.equal(--lockDepth, 0); } }) },
    SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss, create: () => ss },
    DriveApp: { createFolder: folder, getFolderById: folder },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (algorithm, text) => [...crypto.createHash(algorithm).update(text).digest()],
      getUuid: () => crypto.randomUUID(), base64Decode: text => [...Buffer.from(text, 'base64')],
      formatDate: (date, timezone, format) => format === 'yyyy-MM' ? date.toISOString().slice(0, 7) : date.toISOString().replace(/[-:]/g, '').slice(0, 15)
    },
    ScriptApp: { getOAuthToken: () => 'test-only-oauth', getProjectTriggers: () => [], getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/test/exec' }) },
    Logger: { log() {} },
    UrlFetchApp: { fetch(url, options) { requests.push({ url, options }); const res = responses.shift(); assert.ok(res, 'Unexpected network request: ' + url); return { getResponseCode: () => res.code, getContentText: () => typeof res.body === 'string' ? res.body : JSON.stringify(res.body), getHeaders: () => res.headers || {} }; } },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../Code.gs'), 'utf8'), context);
  context.setup_();
  const admin = context.adminLogin('764321');
  const rpc = (fn, ...args) => {
    const result = context.stationRpc('station-test-key', fn, args);
    if (!result.ok) throw new Error(result.error);
    return result.result;
  };
  return { context, admin, rpc, props, cache, sheets, requests, responses };
}

const order = (overrides = {}) => ({
  resi: '00012345', orderSn: '00000987', buyer: 'pembeli', recipient: 'Penerima', status: 'Perlu Dikirim',
  items: [{ name: 'Serum', variation: '30 ml', sku: 'SRM01', qty: 2 }, { name: 'Toner', variation: '', sku: 'TNR01', qty: 1 }], ...overrides
});
function seedPicking(b) {
  b.context.adminImportOrders(b.admin, [order()]);
  const [picker] = b.context.adminSavePicker(b.admin, { name: 'Sari', code: 'PICK01', pin: '123456' });
  const login = b.context.pickerLogin('pick01', '123456');
  return { picker, token: login.token, lookup: b.context.pickerLookup(login.token, '00012345') };
}
function seedUpload(b, overrides = {}) {
  b.context.adminImportOrders(b.admin, [order(), order({ resi: 'SPX99999', orderSn: 'ORDER002' })]);
  const [packer] = b.context.adminSavePacker(b.admin, { name: 'Budi', code: 'PACK01' });
  const meta = { resi: '00012345', packerId: packer.id, packerName: packer.name, clientRecordId: 'capture-test-0001', size: 4, mime: 'video/webm', startAt: '2026-10-07T01:00:00Z', ...overrides };
  b.responses.push({ code: 200, headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test' } });
  const upload = b.rpc('startVideoUpload', meta);
  const rec = { ...meta, uploadId: upload.uploadId, endAt: '2026-10-07T01:01:00Z', station: 'Meja 1' };
  return { meta, upload, rec, packer };
}
function finishUpload(b, upload) {
  b.responses.push({ code: 200, body: { id: 'test-drive-video' } });
  return b.rpc('uploadVideoChunk', upload.uploadId, Buffer.from('webm').toString('base64'), 0);
}

test('station RPC and admin operations enforce their separate credentials', () => {
  const b = backend();
  for (const fn of ['getBootstrap', 'lookupResi', 'startVideoUpload', 'uploadVideoChunk', 'saveRecord', 'listOrders']) {
    assert.throws(() => b.context[fn](), /Kunci stasiun/);
  }
  assert.equal(b.context.stationRpc('wrong-key', 'getBootstrap', []).ok, false);
  assert.equal(b.context.stationRpc('station-test-key', 'setup_', []).ok, false);
  assert.throws(() => b.context.adminImportOrders('', [order()]), /SESSION:/);
  assert.throws(() => b.rpc('adminGetPickers', 'not-admin'), /SESSION:/);
  assert.equal(b.rpc('getBootstrap').maxSec, 180);
  assert.throws(() => b.context.getBootstrap(), /Kunci stasiun/, 'Station authorization must be reset after a call');
  assert.equal(JSON.parse(b.context.doPost({ postData: { contents: '{bad' } }).text).ok, false);
});

test('admin import preserves text IDs, upserts rows, validates whole batch and escapes formulas', () => {
  const b = backend();
  const malicious = order({ recipient: '=HYPERLINK("https://example.invalid")' });
  assert.equal(b.context.adminImportOrders(b.admin, [malicious]).saved, 1);
  assert.equal(b.sheets.get('Orders').rows[1][0], '00012345');
  assert.equal(b.sheets.get('Orders').rows[1][1], '00000987');
  assert.ok(b.sheets.get('Orders').rows[1][3].startsWith("'="));
  assert.throws(() => b.context.adminImportOrders(b.admin, [order({ resi: 'NEW12345' }), order({ items: [{ name: 'Bad', qty: 0 }] })]), /jumlah/);
  assert.equal(b.sheets.get('Orders').getLastRow(), 2);
  assert.throws(() => b.context.adminImportOrders(b.admin, [order(), order({ orderSn: 'DIFFERENT' })]), /dua nomor/);
  b.context.adminImportOrders(b.admin, [order({ items: [{ name: 'Updated', qty: 3 }] })]);
  assert.equal(b.sheets.get('Orders').getLastRow(), 2);
  assert.equal(b.rpc('lookupResi', '00012345').order.items[0].qty, 3);
});

test('picker login hides PIN hashes and revoked, expired or reset credentials cannot act', () => {
  const b = backend(); const { picker, token } = seedPicking(b);
  assert.equal('pinHash' in picker, false);
  assert.throws(() => b.context.pickerLogin('PICK01', '999999'), /PIN salah/);
  assert.throws(() => b.context.pickerLookup('invalid', '00012345'), /SESSION:/);
  b.context.adminSavePicker(b.admin, { ...picker, pin: '654321' });
  assert.throws(() => b.context.pickerLookup(token, '00012345'), /SESSION:/);
  const next = b.context.pickerLogin('PICK01', '654321').token;
  b.context.adminSavePicker(b.admin, { ...picker, active: false });
  assert.throws(() => b.context.pickerLookup(next, '00012345'), /SESSION:/);
  b.context.adminSavePicker(b.admin, { ...picker, active: true });
  const last = b.context.pickerLogin('PICK01', '654321').token;
  b.context.pickerLogout(last);
  assert.throws(() => b.context.pickerLookup(last, '00012345'), /SESSION:/);
});

test('picking requires every distinct checklist item and current version; retries are idempotent', () => {
  const b = backend(); const { token, lookup } = seedPicking(b);
  const version = lookup.order.orderVersion;
  for (const checked of [[], [0], [0, 0], [0, 2], ['0', 1]]) assert.throws(() => b.context.pickerComplete(token, '00012345', checked, version), /centang/);
  assert.throws(() => b.context.pickerComplete(token, '00012345', [0, 1], 'stale-version'), /berubah/);
  const result = b.context.pickerComplete(token, '00012345', [0, 1], version);
  assert.equal(result.complete, true);
  assert.equal(b.context.pickerComplete(token, '00012345', [1, 0], version).completedAt, result.completedAt);
  assert.equal(b.sheets.get('Picking').getLastRow(), 2);
  assert.equal(b.rpc('listOrders').orders[0].picking.complete, true);
  b.context.adminImportOrders(b.admin, [order({ items: [{ name: 'New item', qty: 4 }] })]);
  assert.equal(b.context.pickerLookup(token, '00012345').picking, null);
  assert.throws(() => b.context.pickerComplete(token, '00012345', [0, 1], version), /berubah/);
  const newVersion = b.context.pickerLookup(token, '00012345').order.orderVersion;
  b.context.pickerComplete(token, '00012345', [0], newVersion);
  assert.equal(b.sheets.get('Picking').getLastRow(), 2);
});

test('unknown, cancelled and unpaid orders cannot be picked or start upload', () => {
  const b = backend(); const { token } = seedPicking(b);
  assert.throws(() => b.context.pickerLookup(token, 'UNKNOWN123'), /belum diimpor/);
  for (const status of ['CANCELLED', 'IN_CANCEL', 'UNPAID', 'Dibatalkan', 'Belum Dibayar']) {
    b.context.adminImportOrders(b.admin, [order({ status })]);
    assert.throws(() => b.context.pickerLookup(token, '00012345'), /dibatalkan/);
    assert.throws(() => b.rpc('startVideoUpload', { resi: '00012345' }), /dibatalkan/);
  }
});

test('Drive upload metadata is bound, bytes stay on server, and records deduplicate after cache expiry', () => {
  const b = backend(); const { meta, upload, rec } = seedUpload(b);
  assert.equal(upload.done, false);
  assert.equal('session' in upload, false);
  assert.equal(b.requests[0].options.headers.Authorization, 'Bearer test-only-oauth');
  assert.equal(JSON.parse(b.requests[0].options.payload).mimeType, 'video/webm');
  assert.equal(b.rpc('startVideoUpload', meta).uploadId, upload.uploadId);
  assert.equal(b.requests.length, 1);
  assert.throws(() => b.rpc('startVideoUpload', { ...meta, size: 5 }), /Metadata/);
  assert.throws(() => b.rpc('saveRecord', rec), /belum selesai/);
  assert.equal(finishUpload(b, upload).done, true);
  assert.equal(b.requests[1].options.headers['Content-Range'], 'bytes 0-3/4');
  assert.throws(() => b.rpc('saveRecord', { ...rec, resi: 'SPX99999' }), /tidak sesuai/);
  assert.throws(() => b.rpc('saveRecord', { ...rec, clientRecordId: 'capture-different' }), /tidak sesuai/);
  assert.throws(() => b.rpc('saveRecord', { ...rec, startAt: '2026-10-07T01:00:01Z' }), /Waktu/);
  const result = b.rpc('saveRecord', rec);
  assert.equal(result.fileId, 'test-drive-video');
  assert.equal(result.status, 'OK');
  assert.equal(b.sheets.get('Records').getLastRow(), 2);
  b.cache.clear();
  assert.equal(b.props.has('UPLOAD_' + upload.uploadId), false);
  assert.equal(b.rpc('saveRecord', rec).recordId, result.recordId);
  assert.equal(b.rpc('startVideoUpload', meta).done, true);
  assert.equal(b.sheets.get('Records').getLastRow(), 2);
  assert.throws(() => b.rpc('saveRecord', { ...rec, resi: 'SPX99999' }), /tidak sesuai/);
});

test('interrupted captures remain identifiable and cannot be relabelled as successful', () => {
  const b = backend(); const { upload, rec } = seedUpload(b, { interrupted: true, interruptionReason: 'Kamera terputus' });
  finishUpload(b, upload);
  const saved = b.rpc('saveRecord', { ...rec, interrupted: false });
  assert.equal(saved.status, 'TERPUTUS');
  assert.match(b.sheets.get('Records').rows[1][13], /Kamera terputus/);
});

test('upload rejects reassignment of its tracking number to a different order', () => {
  const b = backend(); const { upload, rec } = seedUpload(b);
  finishUpload(b, upload);
  b.context.adminImportOrders(b.admin, [order({ orderSn: 'REPLACEMENT-ORDER' })]);
  assert.throws(() => b.rpc('saveRecord', rec), /pesanan.*berubah/i);
  assert.equal(b.sheets.get('Records').getLastRow(), 1);
});

test('resumable chunks enforce Drive alignment and report acknowledged server offset', () => {
  const b = backend(); const { upload } = seedUpload(b, { size: 524288 });
  assert.throws(() => b.rpc('uploadVideoChunk', upload.uploadId, Buffer.from('small').toString('base64'), 0), /Rentang/);
  assert.throws(() => b.rpc('uploadVideoChunk', upload.uploadId, Buffer.alloc(262144).toString('base64'), 1), /Rentang/);
  b.responses.push({ code: 308, headers: { Range: 'bytes=0-262143' } });
  const first = b.rpc('uploadVideoChunk', upload.uploadId, Buffer.alloc(262144).toString('base64'), 0);
  assert.equal(first.done, false); assert.equal(first.next, 262144);
  b.responses.push({ code: 200, body: { id: 'chunked-video' } });
  assert.equal(b.rpc('uploadVideoChunk', upload.uploadId, Buffer.alloc(262144).toString('base64'), first.next).done, true);
  assert.equal(b.rpc('uploadVideoChunk', upload.uploadId, '', 0).done, true, 'Final chunk retries must not create another video');
});
