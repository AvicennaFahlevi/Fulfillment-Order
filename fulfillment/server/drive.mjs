import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILES = 'https://www.googleapis.com/drive/v3/files';
const TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Fulfill — Bukti packing';
const FOLDER_MARKER = 'fulfill-packing-v1';
const STATE_LIFETIME = 10 * 60 * 1000;
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;

function failure(message, status = 502, code = 'DRIVE_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

function queryValue(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function config(env) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_REDIRECT_URI?.trim();
  let validRedirect = false;
  try {
    const url = new URL(redirectUri);
    validRedirect = !url.username && !url.password && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { /* Incomplete server configuration is reported without its values. */ }
  return { clientId, clientSecret, redirectUri, configured: Boolean(clientId && clientSecret && validRedirect) };
}

/** Google Drive transport. Callers own and must remove temporary upload files in finally. */
export function createDrive({ dataDir, env = process.env, fetchImpl = globalThis.fetch }) {
  if (!dataDir) throw new TypeError('dataDir wajib diisi.');
  const keyPath = join(dataDir, 'drive.key');
  const tokenPath = join(dataDir, 'drive-tokens.enc');
  const states = new Map();
  const uploads = new Map();
  let tokens;
  let loading;
  let refreshing;
  let key;
  let reconnectRequired = false;
  let lastError;

  function requireConfig() {
    const result = config(env);
    if (!result.configured) throw failure('Konfigurasi Google Drive belum lengkap. Isi Google OAuth di server terlebih dahulu.', 503, 'DRIVE_NOT_CONFIGURED');
    return result;
  }

  async function getKey(create = false) {
    if (key) return key;
    try {
      key = await readFile(keyPath);
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      try {
        await writeFile(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
      }
      key = await readFile(keyPath);
    }
    if (key.length !== 32) {
      key = undefined;
      throw failure('Kunci penyimpanan Google Drive tidak valid. Pulihkan kunci dari cadangan server.', 503, 'DRIVE_STORAGE_ERROR');
    }
    await chmod(keyPath, 0o600);
    return key;
  }

  async function loadTokens() {
    if (tokens !== undefined) return tokens;
    if (loading) return loading;
    loading = (async () => {
      let envelope;
      try {
        envelope = await readFile(tokenPath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return (tokens = null);
        throw failure('Data koneksi Google Drive tidak dapat dibaca.', 503, 'DRIVE_STORAGE_ERROR');
      }
      try {
        const stored = JSON.parse(envelope);
        if (stored.version !== 1) throw new Error('Unsupported token format');
        const decipher = createDecipheriv('aes-256-gcm', await getKey(), Buffer.from(stored.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]);
        const decoded = JSON.parse(plaintext.toString('utf8'));
        if (typeof decoded.refreshToken !== 'string' || !decoded.refreshToken) throw new Error('Invalid token');
        await chmod(tokenPath, 0o600);
        tokens = decoded;
        return tokens;
      } catch {
        throw failure('Koneksi Google Drive tidak dapat dibuka. Pulihkan drive.key yang sesuai atau sambungkan ulang Drive.', 503, 'DRIVE_STORAGE_ERROR');
      }
    })();
    try { return await loading; } finally { loading = undefined; }
  }

  async function saveTokens(value) {
    const tempPath = `${tokenPath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', await getKey(true), iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
      await writeFile(tempPath, envelope, { flag: 'wx', mode: 0o600 });
      await rename(tempPath, tokenPath);
      tokens = value;
    } catch (error) {
      if (error.code === 'DRIVE_STORAGE_ERROR') throw error;
      throw failure('Koneksi Google Drive tidak dapat disimpan. Periksa izin direktori data server.', 503, 'DRIVE_STORAGE_ERROR');
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  }

  async function request(url, options = {}, timeout = 45_000) {
    try {
      return await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error.name)) throw failure('Google Drive terlalu lama merespons. Rekaman tetap dapat dicoba unggah kembali.', 504, 'DRIVE_TIMEOUT');
      throw failure('Google Drive tidak dapat dihubungi. Periksa koneksi server dan coba lagi.', 502, 'DRIVE_UNAVAILABLE');
    }
  }

  async function json(response) {
    try { return await response.json(); } catch {
      throw failure('Google Drive mengirim respons yang tidak dapat dibaca.', 502, 'DRIVE_INVALID_RESPONSE');
    }
  }

  async function checkResponse(response) {
    if (response.ok) return response;
    // Never include upstream error bodies: they may contain credential or request details.
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) {
      reconnectRequired = true;
      lastError = 'Koneksi Google Drive kedaluwarsa. Admin perlu menyambungkan ulang.';
      throw failure(lastError, 409, 'DRIVE_RECONNECT_REQUIRED');
    }
    if (response.status === 403) throw failure('Google Drive menolak akses. Periksa izin akun dan sisa penyimpanan Drive.', 502, 'DRIVE_PERMISSION_DENIED');
    if (response.status === 404) throw failure('File atau folder rekaman tidak ditemukan di Google Drive.', 404, 'DRIVE_FILE_NOT_FOUND');
    if (response.status === 429) throw failure('Batas permintaan Google Drive tercapai. Coba unggah kembali beberapa saat lagi.', 503, 'DRIVE_RATE_LIMIT');
    throw failure('Permintaan Google Drive gagal. Rekaman dapat dicoba unggah kembali.', 502, 'DRIVE_UNAVAILABLE');
  }

  async function accessToken(forceRefresh = false) {
    const cfg = requireConfig();
    const current = await loadTokens();
    if (!current) throw failure('Google Drive belum terhubung. Minta admin menyambungkan Google Drive.', 409, 'DRIVE_NOT_CONNECTED');
    if (!forceRefresh && current.accessToken && current.expiresAt > Date.now() + 60_000) return current.accessToken;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const response = await request(TOKEN, { method: 'POST', body: new URLSearchParams({
        client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: current.refreshToken, grant_type: 'refresh_token',
      }) });
      if (!response.ok) {
        if ([400, 401].includes(response.status)) {
          await response.body?.cancel().catch(() => {});
          reconnectRequired = true;
          lastError = 'Koneksi Google Drive kedaluwarsa atau dicabut. Admin perlu menyambungkan ulang.';
          throw failure(lastError, 409, 'DRIVE_RECONNECT_REQUIRED');
        }
        await checkResponse(response);
      }
      const payload = await json(response);
      if (typeof payload.access_token !== 'string' || !payload.access_token) throw failure('Google tidak memberikan token akses. Sambungkan ulang Drive.', 502, 'DRIVE_INVALID_RESPONSE');
      const updated = { ...current, accessToken: payload.access_token, refreshToken: payload.refresh_token || current.refreshToken,
        expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000 };
      await saveTokens(updated);
      reconnectRequired = false;
      lastError = undefined;
      return updated.accessToken;
    })();
    try { return await refreshing; } finally { refreshing = undefined; }
  }

  async function authorized(url, options = {}, timeout, allowedStatuses = []) {
    let token = await accessToken();
    const makeOptions = () => typeof options === 'function' ? options() : options;
    const run = () => {
      const init = makeOptions();
      return request(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } }, timeout);
    };
    let response = await run();
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      token = await accessToken(true);
      response = await run();
    }
    return allowedStatuses.includes(response.status) ? response : checkResponse(response);
  }

  async function folderFor(token) {
    const perform = token ? async (url, options = {}) => checkResponse(await request(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } })) : authorized;
    const url = new URL(FILES);
    url.searchParams.set('q', `trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='fulfillFolder' and value='${FOLDER_MARKER}' }`);
    url.searchParams.set('fields', 'files(id)');
    url.searchParams.set('pageSize', '1');
    const found = await json(await perform(url));
    if (found.files?.[0]?.id && idPattern.test(found.files[0].id)) return found.files[0].id;
    const create = new URL(FILES);
    create.searchParams.set('fields', 'id');
    const folder = await json(await perform(create, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { fulfillFolder: FOLDER_MARKER } }),
    }));
    if (!idPattern.test(folder.id || '')) throw failure('Folder Google Drive tidak berhasil dibuat.', 502, 'DRIVE_INVALID_RESPONSE');
    return folder.id;
  }

  async function appFolder() {
    await accessToken();
    const current = await loadTokens();
    // Discover by the app marker instead of trusting a user-supplied folder ID.
    const folderId = await folderFor();
    if (current.folderId !== folderId) await saveTokens({ ...tokens, folderId });
    return folderId;
  }

  async function status() {
    const configured = config(env).configured;
    try {
      const current = await loadTokens();
      const connected = Boolean(configured && current?.refreshToken && current?.folderId && !reconnectRequired);
      return { configured, connected, folderUrl: current?.folderId && idPattern.test(current.folderId) ? `https://drive.google.com/drive/folders/${current.folderId}` : null,
        ...(lastError ? { error: lastError } : {}) };
    } catch (error) {
      return { configured, connected: false, folderUrl: null, error: error.message };
    }
  }

  async function connect(adminId) {
    const cfg = requireConfig();
    if (typeof adminId !== 'string' || !adminId) throw failure('Silakan masuk sebagai admin terlebih dahulu.', 401, 'DRIVE_ADMIN_REQUIRED');
    for (const [state, stored] of states) if (stored.expiresAt <= Date.now()) states.delete(state);
    // Keep at most one pending consent flow per administrator.
    for (const [state, stored] of states) if (stored.adminId === adminId) states.delete(state);
    const state = randomBytes(32).toString('base64url');
    states.set(state, { adminId, expiresAt: Date.now() + STATE_LIFETIME });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [name, value] of Object.entries({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state })) url.searchParams.set(name, value);
    return { url: url.toString() };
  }

  async function callback({ code, state, adminId }) {
    const pending = typeof state === 'string' ? states.get(state) : undefined;
    if (typeof state === 'string') states.delete(state); // Consume before any await, even on a failed exchange.
    if (!pending || pending.expiresAt <= Date.now() || !adminId || pending.adminId !== adminId) {
      throw failure('Permintaan koneksi Drive tidak valid atau sudah kedaluwarsa. Mulai lagi dari halaman admin.', 400, 'DRIVE_INVALID_STATE');
    }
    if (typeof code !== 'string' || !code || code.length > 4096) throw failure('Izin Google Drive belum diberikan. Coba hubungkan kembali.', 400, 'DRIVE_AUTH_DENIED');
    const cfg = requireConfig();
    const response = await request(TOKEN, { method: 'POST', body: new URLSearchParams({
      code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code',
    }) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failure('Google tidak dapat menyelesaikan koneksi. Periksa konfigurasi OAuth lalu hubungkan kembali.', 400, 'DRIVE_OAUTH_FAILED');
    }
    const payload = await json(response);
    if (!payload.access_token || !payload.refresh_token || (payload.scope && !payload.scope.split(' ').includes(SCOPE))) {
      throw failure('Google belum memberikan izin penyimpanan berkelanjutan. Hubungkan kembali dan setujui akses file aplikasi.', 400, 'DRIVE_SCOPE_REQUIRED');
    }
    // A reconnect may select a different account: never reuse the previous account's folder or refresh token.
    const folderId = await folderFor(payload.access_token);
    await saveTokens({ accessToken: payload.access_token, refreshToken: payload.refresh_token,
      expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000, folderId });
    reconnectRequired = false;
    lastError = undefined;
  }

  async function performUpload({ recordingId, path, mimeType, filename }) {
    if (!idPattern.test(recordingId || '') || !['video/webm', 'video/mp4'].includes(mimeType)) {
      throw failure('Identitas atau jenis rekaman tidak valid.', 400, 'DRIVE_INVALID_UPLOAD');
    }
    const local = await stat(path);
    if (!local.isFile() || local.size < 1) throw failure('File rekaman kosong atau tidak ditemukan.', 400, 'DRIVE_INVALID_UPLOAD');
    const folderId = await appFolder();
    const search = new URL(FILES);
    search.searchParams.set('q', `trashed = false and ${queryValue(folderId)} in parents and appProperties has { key='recordingId' and value=${queryValue(recordingId)} }`);
    search.searchParams.set('fields', 'files(id,size,mimeType)');
    const existing = await json(await authorized(search));
    if (existing.files?.length) {
      const file = existing.files[0];
      if (!idPattern.test(file.id || '') || Number(file.size) !== local.size || file.mimeType !== mimeType) {
        throw failure('Rekaman dengan identitas ini sudah ada tetapi ukuran atau jenisnya berbeda. Hubungi admin.', 409, 'DRIVE_RECORDING_CONFLICT');
      }
      return { id: file.id, bytes: Number(file.size) };
    }
    const start = new URL('https://www.googleapis.com/upload/drive/v3/files');
    start.searchParams.set('uploadType', 'resumable');
    start.searchParams.set('fields', 'id,size');
    const initialized = await authorized(start, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(local.size) },
      body: JSON.stringify({ name: String(filename || `${recordingId}.${mimeType === 'video/mp4' ? 'mp4' : 'webm'}`).slice(0, 240),
        parents: [folderId], mimeType, appProperties: { recordingId } }),
    });
    const location = initialized.headers.get('location');
    await initialized.body?.cancel().catch(() => {});
    let uploadUrl;
    try { uploadUrl = new URL(location); } catch { /* Validated below. */ }
    if (!uploadUrl || uploadUrl.origin !== 'https://www.googleapis.com' || uploadUrl.pathname !== '/upload/drive/v3/files' || uploadUrl.username || uploadUrl.password) {
      throw failure('Alamat unggahan Google Drive tidak valid.', 502, 'DRIVE_INVALID_RESPONSE');
    }
    const completed = await authorized(uploadUrl, () => ({
      method: 'PUT', duplex: 'half', headers: { 'Content-Type': mimeType, 'Content-Length': String(local.size), 'Content-Range': `bytes 0-${local.size - 1}/${local.size}` },
      body: createReadStream(path),
    }), 5 * 60_000);
    const file = await json(completed);
    if (!idPattern.test(file.id || '') || Number(file.size) !== local.size) {
      throw failure('Ukuran rekaman di Google Drive belum terkonfirmasi. Coba unggah kembali untuk memeriksa hasilnya.', 502, 'DRIVE_INVALID_RESPONSE');
    }
    return { id: file.id, bytes: Number(file.size) };
  }

  async function upload(input) {
    const existing = uploads.get(input.recordingId);
    if (existing) return existing;
    const pending = performUpload(input);
    uploads.set(input.recordingId, pending);
    try { return await pending; } finally { uploads.delete(input.recordingId); }
  }

  async function media(fileId, range) {
    if (!idPattern.test(fileId || '')) throw failure('Identitas video tidak valid.', 400, 'DRIVE_INVALID_FILE');
    if (range && (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 100)) throw failure('Rentang video tidak valid.', 416, 'DRIVE_INVALID_RANGE');
    const folderId = await appFolder();
    const metadataUrl = new URL(`${FILES}/${encodeURIComponent(fileId)}`);
    metadataUrl.searchParams.set('fields', 'id,parents,appProperties,mimeType,trashed');
    const metadata = await json(await authorized(metadataUrl));
    if (metadata.trashed || !metadata.parents?.includes(folderId) || !metadata.appProperties?.recordingId || !['video/webm', 'video/mp4'].includes(metadata.mimeType)) {
      throw failure('Video ini bukan rekaman milik aplikasi.', 404, 'DRIVE_FILE_NOT_FOUND');
    }
    return authorized(`${FILES}/${encodeURIComponent(fileId)}?alt=media`, { headers: range ? { Range: range } : {} }, 5 * 60_000, [416]);
  }

  return { status, connect, callback, upload, media };
}
