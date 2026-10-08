import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import ExcelJS from 'exceljs';
import { createApp } from '../server/app.mjs';
import { createAdmin } from '../server/db.mjs';
import { testDatabase } from './database.mjs';

const password = 'integration-only-password';
const video = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28, 42)]);
const sample = (tracking = '00012345', overrides = {}) => ({ tracking, orderNumber: `ORDER-${tracking}`, buyer: 'pembeli', recipient: 'Penerima', sourceStatus: 'Perlu Dikirim',
  items: [{ name: 'Kemeja', sku: 'SKU-01', variant: 'M', quantity: 2 }, { name: 'Celana', sku: 'SKU-02', variant: 'L', quantity: 1 }], ...overrides });

async function fixture(t, options = {}) {
  const database = await testDatabase();
  t.after(() => database.close());
  const dataDir = await mkdtemp(join(tmpdir(), 'fulfill-api-'));
  const files = new Map();
  const drive = {
    calls: [], failure: null,
    async status() { return { configured: true, connected: true, folderUrl: 'https://drive.google.com/drive/folders/test-folder' }; },
    async connect() { return { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=stub' }; },
    async callback() {},
    async upload(input) {
      this.calls.push(input);
      if (this.failure) throw this.failure;
      const bytes = await readFile(input.path);
      const id = `drive-${input.recordingId}`;
      files.set(id, bytes);
      return { id, bytes: bytes.length };
    },
    async media(id, range) {
      const bytes = files.get(id);
      if (range === 'bytes=999-') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
      const part = range ? bytes.subarray(0, 4) : bytes;
      return new Response(part, { status: range ? 206 : 200, headers: { 'Content-Type': 'video/webm', 'Content-Length': String(part.length),
        'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes 0-3/${bytes.length}` } : {}) } });
    },
    ...options.drive,
  };
  if (options.spa) {
    await mkdir(join(dataDir, 'dist'));
    await writeFile(join(dataDir, 'dist/index.html'), '<!doctype html><title>Fulfill test</title>');
  }
  const app = createApp({ database: database.db, dataDir, drive, env: options.env || {}, distDir: options.spa ? join(dataDir, 'dist') : join(dataDir, 'missing') });
  const adminUser = await createAdmin(app.locals.db, { username: 'admin', name: 'Admin', password });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const client = () => ({
    cookie: '',
    async fetch(path, init = {}) {
      return fetch(base + path, { ...init, headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...init.headers } });
    },
    async call(method, path, body, init = {}) {
      const multipart = body instanceof FormData;
      const response = await this.fetch(path, { method, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body),
        headers: multipart ? {} : { 'Content-Type': 'application/json' } }), ...init });
      const result = { status: response.status, headers: response.headers, body: await response.json() };
      const cookie = response.headers.get('set-cookie');
      if (cookie) this.cookie = cookie.split(';')[0];
      return result;
    },
  });
  const anon = client(), admin = client();
  const login = async (who, username, value = password) => who.call('POST', '/api/auth/login', { username, password: value });
  assert.equal((await login(admin, 'admin')).status, 200);
  const users = { admin: adminUser };
  const clients = { admin, anon };
  for (const role of ['picker', 'packer', 'packer2']) {
    const created = await admin.call('POST', '/api/users', { username: role, name: role, role: role === 'packer2' ? 'packer' : role, password });
    assert.equal(created.status, 201);
    users[role] = created.body.user;
    clients[role] = client();
    assert.equal((await login(clients[role], role)).status, 200);
  }
  const importOrder = async (order = sample()) => { const result = await admin.call('POST', '/api/imports/confirm', { orders: [order] }); assert.equal(result.status, 200); return order; };
  const ready = async (order = sample()) => {
    await importOrder(order);
    const current = (await clients.picker.call('GET', `/api/orders/${order.tracking}`)).body.order;
    const picked = await clients.picker.call('POST', `/api/picking/${order.tracking}/complete`, { version: current.version, checked: current.items.map((_, index) => index) });
    assert.equal(picked.status, 200);
    return picked.body.order;
  };
  const start = (tracking = '00012345', clientId = `client-${tracking}`, who = clients.packer) => who.call('POST', '/api/recordings/start', { tracking, station: 'Meja 1', clientId });
  const upload = (id, { bytes = video, mime = 'video/webm', duration = '12.5', interrupted = 'false', who = clients.packer } = {}) => {
    const body = new FormData(); body.set('video', new Blob([bytes], { type: mime }), 'record.webm'); body.set('duration', duration); body.set('interrupted', interrupted);
    return who.call('POST', `/api/recordings/${id}/upload`, body);
  };
  return { app, dataDir, base, ...clients, client, users, login, importOrder, ready, start, upload, drive };
}

test('session cookies enforce roles, origin checks, password changes and logout', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.anon.call('GET', '/api/auth/me')).body, { user: null });
  assert.equal((await f.anon.call('GET', '/api/orders')).status, 401);
  assert.equal((await f.picker.call('GET', '/api/orders')).status, 403);
  assert.equal((await f.packer.call('GET', '/api/users')).status, 403);
  assert.equal((await f.picker.call('POST', '/api/imports/confirm', { orders: [sample()] })).status, 403);
  assert.equal((await f.picker.call('POST', '/api/recordings/start', { tracking: 'none' })).status, 403);
  assert.equal((await f.login(f.anon, 'unknown')).status, 401);
  const login = await f.login(f.picker, 'PICKER');
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal('password' in login.body.user, false);
  assert.equal((await f.admin.call('POST', '/api/imports/confirm', { orders: [sample()] }, { headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await f.admin.call('PATCH', `/api/users/${f.users.picker.id}`, { password: 'replacement-password' })).status, 200);
  assert.equal((await f.picker.call('GET', '/api/auth/me')).body.user, null);
  assert.equal((await f.login(f.picker, 'picker')).status, 401);
  assert.equal((await f.login(f.picker, 'picker', 'replacement-password')).status, 200);
  assert.equal((await f.picker.call('POST', '/api/auth/logout')).status, 200);
  assert.equal((await f.picker.call('GET', '/api/auth/me')).body.user, null);
  assert.equal((await f.admin.call('PATCH', `/api/users/${f.users.packer.id}`, { active: false })).status, 200);
  assert.equal((await f.packer.call('GET', '/api/integrations/drive/status')).status, 401);
});

test('staff validation protects the last administrator and disallows undeclared fields', async t => {
  const f = await fixture(t);
  assert.equal((await f.admin.call('PATCH', `/api/users/${f.users.admin.id}`, { active: false })).status, 409);
  for (const patch of [{ active: 'false' }, { role: 'admin' }, { name: ' ' }, []]) assert.equal((await f.admin.call('PATCH', `/api/users/${f.users.picker.id}`, patch)).status, 400);
  for (const patch of [{ username: 'a b' }, { role: 'owner' }, { password: 'short' }, { active: false }, { name: 'bad\nname' }]) {
    const body = { username: 'new-user', name: 'User', role: 'picker', password, ...patch };
    assert.equal((await f.admin.call('POST', '/api/users', body)).status, 400);
  }
  assert.equal((await f.admin.call('POST', '/api/users', { username: 'picker', name: 'Duplicate', role: 'picker', password })).status, 409);
});

test('CSV preview groups resi, preserves leading zeroes and performs no mutation', async t => {
  const f = await fixture(t);
  const csv = '\ufeffNo. Resi;No. Pesanan;Nama Produk;Jumlah;Nama Pembeli;Nama Penerima;Status Pesanan;Nomor Referensi SKU;Nama Variasi\n00012345;000987;Kemeja;2;pembeli;Penerima;Perlu Dikirim;0001;M\n00012345;000987;Celana;1;pembeli;Penerima;Perlu Dikirim;0002;L\n;PENDING;Barang;1;pembeli;Penerima;Belum Dibayar;0003;\n';
  const body = new FormData(); body.set('file', new Blob([csv]), 'pesanan.csv');
  const preview = await f.admin.call('POST', '/api/imports/preview', body);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.orders.length, 1);
  assert.equal(preview.body.skipped, 1);
  assert.equal(preview.body.orders[0].tracking, '00012345');
  assert.equal(preview.body.orders[0].orderNumber, '000987');
  assert.equal(preview.body.orders[0].items.length, 2);
  assert.equal(preview.body.orders[0].items[0].sku, '0001');
  assert.equal((await f.admin.call('GET', '/api/orders')).body.total, 0);
  assert.deepEqual((await f.admin.call('POST', '/api/imports/confirm', { orders: preview.body.orders })).body, { imported: 1, updated: 0 });
});

test('XLSX preview handles formatted identifiers and rejects formulas, invalid quantity and columns', async t => {
  const f = await fixture(t);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Pesanan');
  sheet.addRow(['Nomor Resi', 'Nomor Pesanan', 'Nama Produk', 'Jumlah']);
  sheet.addRow([123, '000777', 'Kaos', 1]); sheet.getCell('A2').numFmt = '000000';
  const preview = async () => {
    const body = new FormData(); body.set('file', new Blob([await workbook.xlsx.writeBuffer()]), 'pesanan.xlsx');
    return f.admin.call('POST', '/api/imports/preview', body);
  };
  const parsed = await preview(); assert.equal(parsed.status, 200); assert.equal(parsed.body.orders[0].tracking, '000123');
  sheet.getCell('D2').value = { formula: '1+1', result: 2 };
  assert.equal((await preview()).status, 400);
  sheet.getCell('D2').value = 0; assert.equal((await preview()).status, 400);
  sheet.getCell('A1').value = 'Unknown'; assert.equal((await preview()).status, 400);
  assert.equal((await f.admin.call('GET', '/api/orders')).body.total, 0);
});

test('confirm revalidates input and atomically rolls back a batch when packing blocks changes', async t => {
  const f = await fixture(t);
  for (const orders of [[sample('bad', { items: [{ name: 'Item', quantity: -1 }] })], [sample(), sample()], []]) {
    assert.equal((await f.admin.call('POST', '/api/imports/confirm', { orders })).status, 400);
  }
  await f.ready(); assert.equal((await f.start()).status, 200);
  const response = await f.admin.call('POST', '/api/imports/confirm', { orders: [sample('NEW-BATCH'), sample()] });
  assert.equal(response.status, 409);
  assert.equal((await f.admin.call('GET', '/api/orders/NEW-BATCH')).status, 404);
  assert.equal((await f.admin.call('GET', '/api/orders')).body.total, 1);
});

test('picker requires full unique checklist/current version and changed items reset readiness', async t => {
  const f = await fixture(t); await f.importOrder();
  const endpoint = '/api/picking/00012345/complete';
  for (const checked of [[], [0], [0, 0], [0, 2], ['0', 1]]) assert.equal((await f.picker.call('POST', endpoint, { version: 1, checked })).status, 400);
  assert.equal((await f.picker.call('POST', endpoint, { version: 999, checked: [0, 1] })).body.code, 'VERSION_CONFLICT');
  const picked = await f.picker.call('POST', endpoint, { version: 1, checked: [0, 1] });
  assert.equal(picked.body.order.status, 'READY'); assert.equal(picked.body.order.pickedBy, f.users.picker.id);
  assert.equal(picked.body.order.version, 2);
  assert.deepEqual((await f.picker.call('POST', endpoint, { version: 1, checked: [0, 1] })).body, picked.body);
  await f.importOrder(sample('00012345', { items: [{ name: 'Revisi', quantity: 1 }] }));
  const changed = (await f.picker.call('GET', '/api/orders/00012345')).body.order;
  assert.equal(changed.status, 'NEW'); assert.equal(changed.pickedBy, null); assert.equal(changed.version, 3);
  assert.equal((await f.picker.call('POST', endpoint, { version: 1, checked: [0] })).status, 409);
  for (const [index, sourceStatus] of ['Dibatalkan', 'Menunggu Pembayaran', 'To Pay', 'Belum Dibayar', 'Pending Payment'].entries()) {
    const tracking = `BLOCKED-${index}`;
    await f.importOrder(sample(tracking, { sourceStatus }));
    assert.equal((await f.picker.call('POST', `/api/picking/${tracking}/complete`, { version: 1, checked: [0, 1] })).status, 409);
  }
});

test('recording start is idempotent and only one packer can claim each ready order', async t => {
  const f = await fixture(t); await f.importOrder();
  assert.equal((await f.start()).status, 409);
  await f.ready();
  const claims = await Promise.all([f.start('00012345', 'claim-a'), f.start('00012345', 'claim-b', f.packer2)]);
  assert.deepEqual(claims.map(value => value.status).sort(), [200, 409]);
  const index = claims.findIndex(value => value.status === 200);
  const winner = index ? f.packer2 : f.packer;
  const loser = index ? f.packer : f.packer2;
  const clientId = index ? 'claim-b' : 'claim-a';
  const repeated = await f.start('00012345', clientId, winner);
  assert.deepEqual(repeated.body, claims[index].body);
  assert.equal((await f.start('00012345', clientId, loser)).status, 409);
  assert.equal((await f.picker.call('POST', '/api/picking/00012345/complete', { version: 3, checked: [0, 1] })).status, 409);
  assert.equal((await f.app.locals.db.query("SELECT count(*)::integer AS n FROM fulfill.recordings WHERE status='RECORDING'")).rows[0].n, 1);
});

test('video upload goes to Drive, confirms packing once, cleans spool and serves authorized byte ranges', async t => {
  const f = await fixture(t); await f.ready();
  const started = await f.start(); const id = started.body.recording.id;
  assert.equal((await f.upload(id, { who: f.packer2 })).status, 403);
  const saved = await f.upload(id);
  assert.equal(saved.status, 200); assert.equal(saved.body.recording.status, 'SAVED'); assert.equal(saved.body.order.status, 'PACKED');
  assert.equal(saved.body.recording.bytes, video.length); assert.ok(saved.body.recording.driveFileId);
  assert.equal(f.drive.calls.length, 1); assert.deepEqual(await readdir(join(f.dataDir, 'tmp')), []);
  const retried = await f.upload(id); assert.equal(retried.status, 200); assert.equal(retried.body.recording.id, id); assert.equal(f.drive.calls.length, 1);
  const path = saved.body.recording.videoUrl;
  assert.equal((await f.anon.fetch(path)).status, 401); assert.equal((await f.picker.fetch(path)).status, 403); assert.equal((await f.packer2.fetch(path)).status, 403);
  const full = await f.admin.fetch(path); assert.equal(full.status, 200); assert.deepEqual(Buffer.from(await full.arrayBuffer()), video);
  const partial = await f.packer.fetch(path, { headers: { Range: 'bytes=0-3' } });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), `bytes 0-3/${video.length}`); assert.equal((await partial.arrayBuffer()).byteLength, 4);
  assert.equal((await f.packer.fetch(path, { headers: { Range: 'bytes=-' } })).status, 416);
  assert.equal((await f.packer.fetch(path, { headers: { Range: 'bytes=0-1,3-4' } })).status, 416);
  const unavailable = await f.packer.fetch(path, { headers: { Range: 'bytes=999-' } }); assert.equal(unavailable.status, 416); assert.equal(unavailable.headers.get('content-range'), `bytes */${video.length}`);
  assert.equal((await f.admin.call('POST', '/api/imports/confirm', { orders: [sample()] })).status, 200);
  assert.equal((await f.admin.call('POST', '/api/imports/confirm', { orders: [sample('00012345', { buyer: 'changed' })] })).status, 409);
});

test('invalid videos and unavailable Drive do not complete orders and leave no temporary files', async t => {
  const f = await fixture(t); await f.ready(); const id = (await f.start()).body.recording.id;
  for (const options of [{ bytes: Buffer.alloc(32) }, { duration: 'NaN' }, { duration: '0' }, { interrupted: 'yes' }, { mime: 'text/plain' }]) {
    assert.equal((await f.upload(id, options)).status, 400); assert.deepEqual(await readdir(join(f.dataDir, 'tmp')), []);
  }
  assert.equal(f.drive.calls.length, 0);
  f.drive.failure = Object.assign(new Error('Google Drive belum terhubung.'), { status: 409, code: 'DRIVE_NOT_CONNECTED' });
  const failed = await f.upload(id); assert.equal(failed.status, 409); assert.equal(failed.body.code, 'DRIVE_NOT_CONNECTED');
  assert.equal((await f.admin.call('GET', '/api/orders/00012345')).body.order.status, 'PACKING'); assert.deepEqual(await readdir(join(f.dataDir, 'tmp')), []);
  f.drive.failure = null; assert.equal((await f.upload(id)).body.recording.status, 'SAVED');
});

test('interrupted uploads preserve evidence and return the order to ready; admin release requires confirmation', async t => {
  const f = await fixture(t); await f.ready(); const first = (await f.start()).body.recording.id;
  const interrupted = await f.upload(first, { interrupted: 'true' });
  assert.equal(interrupted.body.recording.status, 'INTERRUPTED'); assert.equal(interrupted.body.order.status, 'READY'); assert.ok(interrupted.body.recording.driveFileId);
  const second = (await f.start('00012345', 'record-again')).body.recording.id;
  assert.equal((await f.admin.call('PATCH', `/api/recordings/${second}/release`, {})).status, 400);
  assert.equal((await f.packer.call('PATCH', `/api/recordings/${second}/release`, { confirm: true })).status, 403);
  assert.equal((await f.admin.call('PATCH', `/api/recordings/${second}/release`, { confirm: true })).status, 200);
  assert.equal((await f.admin.call('GET', '/api/orders/00012345')).body.order.status, 'READY');
  assert.equal((await f.upload(second)).status, 409);
  assert.equal((await f.admin.call('PATCH', `/api/recordings/${first}/release`, { confirm: true })).status, 409);
  const third = (await f.start('00012345', 'record-third')).body.recording.id;
  assert.equal((await f.packer2.call('POST', `/api/recordings/${third}/cancel`, {})).status, 403);
  assert.equal((await f.packer.call('POST', `/api/recordings/${third}/cancel`, { reason: 'Kamera dilepas' })).status, 200);
  assert.equal((await f.admin.call('GET', '/api/orders/00012345')).body.order.status, 'READY');
});

test('release and simultaneous retry cannot race an upload in progress', async t => {
  let unblock, entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const f = await fixture(t, { drive: { async upload(input) { entered(); await gate; return { id: `drive-${input.recordingId}` }; } } });
  await f.ready(); const id = (await f.start()).body.recording.id;
  const request = f.upload(id);
  await pending;
  assert.equal((await f.upload(id)).status, 409);
  assert.equal((await f.admin.call('PATCH', `/api/recordings/${id}/release`, { confirm: true })).status, 409);
  assert.equal((await f.packer.call('POST', `/api/recordings/${id}/cancel`, {})).status, 409);
  unblock(); assert.equal((await request).status, 200);
});

test('production serves SPA deep links while unknown APIs stay JSON and OAuth returns to APP_ORIGIN', async t => {
  const f = await fixture(t, { spa: true, env: { APP_ORIGIN: 'http://localhost:5173' } });
  const page = await f.anon.fetch('/picker'); assert.equal(page.status, 200); assert.match(await page.text(), /Fulfill test/);
  const missing = await f.anon.call('GET', '/api/missing'); assert.equal(missing.status, 404); assert.ok(missing.body.error);
  assert.equal((await f.picker.call('GET', '/api/integrations/drive/status')).status, 403);
  assert.equal((await f.packer.call('POST', '/api/integrations/drive/connect')).status, 403);
  const callback = await f.admin.fetch('/api/integrations/drive/callback?code=stub&state=stub', { redirect: 'manual' });
  assert.equal(callback.status, 302); assert.equal(callback.headers.get('location'), 'http://localhost:5173/admin?tab=drive&drive=connected');
});

test('PostgreSQL search preserves case-insensitive matching and literal wildcard characters', async t => {
  const f = await fixture(t);
  await f.importOrder(sample('RESI_%', { buyer: 'Pembeli MixedCase' }));
  await f.importOrder(sample('RESI-OTHER'));
  const searched = await f.admin.call('GET', '/api/orders?q=mixedcase&status=NEW&limit=1');
  assert.equal(searched.status, 200);
  assert.equal(searched.body.total, 1);
  assert.equal(searched.body.orders[0].tracking, 'RESI_%');
  assert.equal((await f.admin.call('GET', '/api/orders?q=%25')).body.total, 1);
  assert.equal((await f.admin.call('GET', '/api/orders?q=%27%20OR%201%3D1--')).body.total, 0);
  const dashboard = await f.admin.call('GET', '/api/dashboard');
  assert.equal(dashboard.body.counts.total, 2);
  assert.equal(typeof dashboard.body.counts.total, 'number');
});

test('concurrent identical recording starts return one persistent recording', async t => {
  const f = await fixture(t);
  await f.ready();
  const results = await Promise.all([f.start(), f.start()]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.deepEqual(results[0].body, results[1].body);
  assert.equal((await f.admin.call('GET', '/api/recordings')).body.recordings.length, 1);
});

test('concurrent administrator deactivation preserves at least one active administrator', async t => {
  const f = await fixture(t);
  const second = await f.admin.call('POST', '/api/users', { username: 'admin-two', name: 'Admin Two', role: 'admin', password });
  const results = await Promise.all([
    f.admin.call('PATCH', `/api/users/${f.users.admin.id}`, { active: false }),
    f.admin.call('PATCH', `/api/users/${second.body.user.id}`, { active: false }),
  ]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.ok(results.some(result => [401, 409].includes(result.status)));
  assert.equal((await f.app.locals.db.query("SELECT count(*)::integer AS n FROM fulfill.users WHERE role='admin' AND active=1")).rows[0].n, 1);
});
