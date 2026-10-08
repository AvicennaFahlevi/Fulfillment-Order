import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDrive } from '../server/drive.mjs';

const env = { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-client-secret', GOOGLE_REDIRECT_URI: 'http://localhost:3100/api/integrations/drive/callback' };
const scope = 'https://www.googleapis.com/auth/drive.file';
const access = 'test-access-value';
const refresh = 'test-refresh-value';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function google() {
  const mock = { calls: [], files: new Map(), sessions: new Map(), folder: null, uploads: 0, refreshes: 0, expiresIn: 3600, metadataOutside: false, range416: false,
    refreshRevoked: false, tokenUnauthorized: false, externalUpload: false, omittedRefresh: false, networkDown: false };
  mock.fetch = async (input, init = {}) => {
    const url = new URL(input); const method = init.method || 'GET';
    mock.calls.push({ host: url.host, pathname: url.pathname, method });
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    if (mock.networkDown) throw new TypeError('Network failure with possible private details');
    if (url.href === 'https://oauth2.googleapis.com/token') {
      assert.equal(method, 'POST'); assert.ok(init.body instanceof URLSearchParams);
      assert.equal(init.body.get('client_secret'), env.GOOGLE_CLIENT_SECRET);
      if (init.body.get('grant_type') === 'refresh_token') {
        mock.refreshes++; assert.equal(init.body.get('refresh_token'), refresh);
        if (mock.refreshRevoked) return json({ error: 'invalid_grant', private: env.GOOGLE_CLIENT_SECRET }, 400);
        return json({ access_token: `${access}-renewed`, expires_in: 3600 });
      }
      assert.equal(init.body.get('grant_type'), 'authorization_code');
      assert.equal(init.body.get('redirect_uri'), env.GOOGLE_REDIRECT_URI);
      return json({ access_token: access, ...(!mock.omittedRefresh ? { refresh_token: refresh } : {}), expires_in: mock.expiresIn, scope });
    }
    assert.equal(url.host, 'www.googleapis.com', 'Only official Google hosts receive credentials');
    assert.match(init.headers.Authorization, /^Bearer test-access-value(?:-renewed)?$/);
    if (mock.tokenUnauthorized) { mock.tokenUnauthorized = false; return json({ private: 'must-never-be-forwarded' }, 401); }
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const query = url.searchParams.get('q');
      if (query.includes('fulfillFolder')) return json({ files: mock.folder ? [{ id: mock.folder }] : [] });
      assert.match(query, /recordingId/);
      const recordingId = query.match(/value='([^']+)'/)[1];
      const file = [...mock.files.values()].find(file => file.recordingId === recordingId);
      return json({ files: file ? [{ id: file.id, size: String(file.bytes.length), mimeType: file.mimeType }] : [] });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const body = JSON.parse(init.body); assert.equal(body.mimeType, 'application/vnd.google-apps.folder');
      assert.equal(body.appProperties.fulfillFolder, 'fulfill-packing-v1');
      mock.folder = 'folder-test'; return json({ id: mock.folder });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      assert.equal(url.searchParams.get('uploadType'), 'resumable');
      const pending = JSON.parse(init.body); assert.deepEqual(pending.parents, ['folder-test']);
      const session = String(mock.sessions.size + 1); mock.sessions.set(session, pending);
      return new Response(null, { status: 200, headers: { Location: mock.externalUpload ? 'https://evil.invalid/collect' : `https://www.googleapis.com/upload/drive/v3/files?upload_id=${session}` } });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'PUT') {
      mock.uploads++; assert.equal(init.duplex, 'half');
      const chunks = []; for await (const chunk of init.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks); assert.equal(init.headers['Content-Length'], String(bytes.length));
      assert.equal(init.headers['Content-Range'], `bytes 0-${bytes.length - 1}/${bytes.length}`);
      const pending = mock.sessions.get(url.searchParams.get('upload_id'));
      const id = `file-${pending.appProperties.recordingId}`;
      mock.files.set(id, { id, bytes, mimeType: pending.mimeType, recordingId: pending.appProperties.recordingId });
      return json({ id, size: String(bytes.length) });
    }
    if (url.pathname.startsWith('/drive/v3/files/')) {
      const file = mock.files.get(url.pathname.split('/').at(-1));
      if (!file) return json({ error: 'not found' }, 404);
      if (url.searchParams.get('alt') !== 'media') return json({ id: file.id, parents: mock.metadataOutside ? ['other-folder'] : ['folder-test'],
        mimeType: file.mimeType, appProperties: { recordingId: file.recordingId }, trashed: false });
      if (mock.range416) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.bytes.length}` } });
      assert.ok(!init.headers.Range || init.headers.Range === 'bytes=0-3');
      return new Response(init.headers.Range ? file.bytes.subarray(0, 4) : file.bytes, { status: init.headers.Range ? 206 : 200,
        headers: { 'Content-Type': file.mimeType, ...(init.headers.Range ? { 'Content-Range': `bytes 0-3/${file.bytes.length}` } : {}) } });
    }
    assert.fail(`Unexpected mock Google request ${method} ${url.pathname}`);
  };
  return mock;
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fulfill-drive-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const mock = google(); Object.assign(mock, overrides);
  const drive = createDrive({ dataDir, env, fetchImpl: mock.fetch });
  const connect = async (target = drive) => {
    const consent = new URL((await target.connect('admin-test')).url);
    await target.callback({ adminId: 'admin-test', state: consent.searchParams.get('state'), code: 'authorization-code' });
    return consent;
  };
  const path = join(dataDir, 'test-video.webm'); const bytes = Buffer.alloc(32, 3); await writeFile(path, bytes);
  const upload = (target = drive, options = {}) => target.upload({ recordingId: 'record-test', path, mimeType: 'video/webm', filename: 'resi_record.webm', ...options });
  return { dataDir, drive, mock, connect, path, bytes, upload };
}

test('Drive reports missing server configuration without making network calls or exposing credentials', async t => {
  const { dataDir } = await fixture(t);
  for (const config of [{}, { ...env, GOOGLE_REDIRECT_URI: 'http://public.example/callback' }]) {
    const drive = createDrive({ dataDir, env: config, fetchImpl: () => assert.fail('No network before valid configuration') });
    assert.deepEqual(await drive.status(), { configured: false, connected: false, folderUrl: null });
    await assert.rejects(drive.connect('admin-test'), { code: 'DRIVE_NOT_CONFIGURED', status: 503 });
  }
});

test('OAuth requires expiring single-use state bound to the initiating admin and asks only for app files', async t => {
  const f = await fixture(t);
  const first = new URL((await f.drive.connect('admin-test')).url);
  assert.equal(first.origin, 'https://accounts.google.com'); assert.equal(first.searchParams.get('scope'), scope);
  assert.equal(first.searchParams.get('access_type'), 'offline'); assert.equal(first.searchParams.get('prompt'), 'consent');
  assert.equal(first.searchParams.has('client_secret'), false);
  const state = first.searchParams.get('state'); assert.ok(state.length >= 40);
  await assert.rejects(f.drive.callback({ state, code: 'code', adminId: 'other-admin' }), { code: 'DRIVE_INVALID_STATE' });
  await assert.rejects(f.drive.callback({ state, code: 'code', adminId: 'admin-test' }), { code: 'DRIVE_INVALID_STATE' });
  assert.equal(f.mock.calls.length, 0);
  const second = new URL((await f.drive.connect('admin-test')).url).searchParams.get('state');
  const third = new URL((await f.drive.connect('admin-test')).url).searchParams.get('state');
  await assert.rejects(f.drive.callback({ state: second, code: 'code', adminId: 'admin-test' }), { code: 'DRIVE_INVALID_STATE' });
  const originalNow = Date.now; const clock = t.mock.method(Date, 'now', () => originalNow() + 11 * 60_000);
  await assert.rejects(f.drive.callback({ state: third, code: 'code', adminId: 'admin-test' }), { code: 'DRIVE_INVALID_STATE' }); clock.mock.restore();
  const successful = await f.connect();
  await assert.rejects(f.drive.callback({ state: successful.searchParams.get('state'), code: 'code', adminId: 'admin-test' }), { code: 'DRIVE_INVALID_STATE' });
});

test('tokens are authenticated-encrypted with private permissions and survive process reload', async t => {
  const f = await fixture(t); await f.connect();
  const ciphertext = await readFile(join(f.dataDir, 'drive-tokens.enc'), 'utf8');
  assert.equal(ciphertext.includes(access), false); assert.equal(ciphertext.includes(refresh), false); assert.equal(ciphertext.includes(env.GOOGLE_CLIENT_SECRET), false);
  assert.equal((await stat(join(f.dataDir, 'drive.key'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.dataDir, 'drive-tokens.enc'))).mode & 0o777, 0o600);
  const reloaded = createDrive({ dataDir: f.dataDir, env, fetchImpl: f.mock.fetch });
  assert.deepEqual(await reloaded.status(), { configured: true, connected: true, folderUrl: 'https://drive.google.com/drive/folders/folder-test' });
  assert.ok((await f.upload(reloaded)).id);
  const envelope = JSON.parse(ciphertext); envelope.data = Buffer.alloc(Buffer.from(envelope.data, 'base64').length, 0).toString('base64');
  await writeFile(join(f.dataDir, 'drive-tokens.enc'), JSON.stringify(envelope));
  const corrupted = createDrive({ dataDir: f.dataDir, env, fetchImpl: f.mock.fetch });
  const status = await corrupted.status(); assert.equal(status.connected, false); assert.match(status.error, /tidak dapat dibuka/);
  await assert.rejects(f.upload(corrupted), { code: 'DRIVE_STORAGE_ERROR' });
  await f.connect(corrupted); assert.equal((await corrupted.status()).connected, true);
});

test('resumable Drive uploads carry recording identity and retries deduplicate across restarts', async t => {
  const f = await fixture(t); await f.connect();
  const [one, simultaneous] = await Promise.all([f.upload(), f.upload()]); assert.deepEqual(one, simultaneous);
  assert.equal(one.bytes, f.bytes.length); assert.equal(f.mock.uploads, 1);
  const restarted = createDrive({ dataDir: f.dataDir, env, fetchImpl: f.mock.fetch });
  assert.deepEqual(await f.upload(restarted), one); assert.equal(f.mock.uploads, 1);
  assert.deepEqual(f.mock.files.get(one.id).bytes, f.bytes);
  await writeFile(f.path, Buffer.alloc(40, 1));
  await assert.rejects(f.upload(restarted), { code: 'DRIVE_RECORDING_CONFLICT', status: 409 });
  assert.equal(f.mock.uploads, 1);
});

test('expired tokens refresh once for concurrent work; revoked refresh requires reconnection', async t => {
  const f = await fixture(t, { expiresIn: -1 }); await f.connect();
  await Promise.all([f.upload(f.drive, { recordingId: 'record-one' }), f.upload(f.drive, { recordingId: 'record-two' })]);
  assert.equal(f.mock.refreshes, 1);
  f.mock.tokenUnauthorized = true;
  const response = await f.drive.media('file-record-one'); assert.equal(response.status, 200); await response.body.cancel();
  assert.equal(f.mock.refreshes, 2);
  f.mock.tokenUnauthorized = true; f.mock.refreshRevoked = true;
  await assert.rejects(f.drive.media('file-record-one'), { code: 'DRIVE_RECONNECT_REQUIRED', status: 409 });
  const status = await f.drive.status(); assert.equal(status.connected, false);
  assert.equal(JSON.stringify(status).includes(env.GOOGLE_CLIENT_SECRET), false);
});

test('Drive streaming validates folder ownership, preserves ranges and handles upstream 416', async t => {
  const f = await fixture(t); await f.connect(); const file = await f.upload();
  const partial = await f.drive.media(file.id, 'bytes=0-3'); assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 4);
  await assert.rejects(f.drive.media(file.id, 'bytes=-'), { status: 416 });
  await assert.rejects(f.drive.media('../etc'), { code: 'DRIVE_INVALID_FILE' });
  f.mock.range416 = true; const missing = await f.drive.media(file.id, 'bytes=0-3'); assert.equal(missing.status, 416); assert.equal(missing.headers.get('content-range'), 'bytes */32');
  f.mock.metadataOutside = true;
  await assert.rejects(f.drive.media(file.id), { code: 'DRIVE_FILE_NOT_FOUND', status: 404 });
});

test('Drive rejects external upload URLs, missing refresh consent and safely reports network failure', async t => {
  const f = await fixture(t, { omittedRefresh: true });
  await assert.rejects(f.connect(), { code: 'DRIVE_SCOPE_REQUIRED' });
  assert.equal((await f.drive.status()).connected, false);
  f.mock.omittedRefresh = false; await f.connect();
  f.mock.externalUpload = true;
  await assert.rejects(f.upload(), { code: 'DRIVE_INVALID_RESPONSE' });
  assert.equal(f.mock.uploads, 0);
  f.mock.networkDown = true;
  await assert.rejects(f.upload(), error => error.code === 'DRIVE_UNAVAILABLE' && !error.message.includes('private details'));
});
