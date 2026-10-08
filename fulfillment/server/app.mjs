import express from 'express';
import multer from 'multer';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openDatabase, transaction, createUser, hashPassword, verifyPassword, validText, publicUser, publicOrder,
  publicRecording, getOrder, getRecording, recordingSql, now, fail, sourceBlocked } from './db.mjs';
import { parseImport, confirmImport } from './imports.mjs';
import { createDrive } from './drive.mjs';

const SESSION_MS = 12 * 60 * 60 * 1000;
const hashToken = value => createHash('sha256').update(value).digest('hex');
const cookieName = 'fulfill_session';
const extensionFor = mime => mime === 'video/mp4' ? 'mp4' : 'webm';
function cookieToken(req) {
  const value = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`));
  const token = value?.slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}
function safeLike(value) { return `%${String(value || '').slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`; }
function limit(value) { const n = Number(value ?? 100); return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 100; }

export function createApp({ dataDir = resolve(process.env.DATA_DIR || './data'), drive, env = process.env, distDir, database } = {}) {
  const app = express();
  const db = database || openDatabase({ connectionString: env.DATABASE_URL });
  const driveService = drive || createDrive({ dataDir, env });
  const spoolDir = join(dataDir, 'tmp');
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  app.disable('x-powered-by');
  if (env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  const uploads = new Set();
  app.locals.db = db;
  app.locals.drive = driveService;
  app.locals.close = () => db.end();
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    res.set('Permissions-Policy', 'camera=(self), microphone=(self)');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin) {
      const expected = env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
      if (origin !== expected) return res.status(403).json({ error: 'Asal permintaan tidak diizinkan.' });
    }
    next();
  });
  app.use(express.json({ limit: '8mb' }));
  app.get('/api/health', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, backend: 'ok', database: 'connected' });
    } catch {
      res.status(503).json({ ok: false, backend: 'ok', database: 'unavailable' });
    }
  });
  app.use('/api', async (req, res, next) => {
    const token = cookieToken(req);
    if (token) {
      const row = (await db.query(`SELECT u.* FROM fulfill.sessions s JOIN fulfill.users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active = 1`, [hashToken(token), Date.now()])).rows[0];
      if (row) req.user = publicUser(row);
    }
    next();
  });
  const auth = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Silakan login terlebih dahulu.' });
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Akun Anda tidak memiliki akses ini.' });
    next();
  };
  const secureCookie = env.COOKIE_SECURE === 'true' || env.APP_ORIGIN?.startsWith('https://');
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: Boolean(secureCookie), path: '/', maxAge: SESSION_MS };
  app.get('/api/auth/me', async (req, res) => res.json({ user: req.user || null }));
  const loginAttempts = new Map();
  const dummyHash = hashPassword(randomBytes(24).toString('hex'));
  app.post('/api/auth/login', async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().trim().slice(0, 60) : '';
    const key = req.ip;
    const previous = loginAttempts.get(key);
    const attempts = previous?.until > Date.now() ? previous : { count: 0, until: Date.now() + 15 * 60 * 1000 };
    if (attempts.count >= 20) fail(429, 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.');
    const row = (await db.query('SELECT * FROM fulfill.users WHERE username = $1', [username])).rows[0];
    const valid = verifyPassword(req.body?.password, row?.password || dummyHash);
    if (!valid || !row?.active) {
      attempts.count++;
      loginAttempts.set(key, attempts);
      if (loginAttempts.size > 10000) for (const [entry, value] of loginAttempts) if (value.until < Date.now()) loginAttempts.delete(entry);
      fail(401, 'Username atau kata sandi salah.');
    }
    loginAttempts.delete(key);
    const token = randomBytes(32).toString('hex');
    const old = cookieToken(req);
    if (old) await db.query('DELETE FROM fulfill.sessions WHERE token_hash = $1', [hashToken(old)]);
    await db.query('DELETE FROM fulfill.sessions WHERE expires_at <= $1', [Date.now()]);
    await db.query('INSERT INTO fulfill.sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)', [hashToken(token), row.id, Date.now() + SESSION_MS]);
    res.cookie(cookieName, token, cookieOptions).json({ user: publicUser(row) });
  });
  app.post('/api/auth/logout', async (req, res) => {
    const token = cookieToken(req);
    if (token) await db.query('DELETE FROM fulfill.sessions WHERE token_hash = $1', [hashToken(token)]);
    res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined }).json({ ok: true });
  });

  app.get('/api/dashboard', auth('admin'), async (req, res) => {
    const counts = { total: 0, new: 0, ready: 0, packing: 0, packed: 0 };
    for (const row of (await db.query('SELECT status, COUNT(*)::integer AS n FROM fulfill.orders GROUP BY status', [])).rows) { counts[row.status.toLowerCase()] = row.n; counts.total += row.n; }
    res.json({ counts, recentOrders: (await db.query('SELECT * FROM fulfill.orders ORDER BY updated_at DESC LIMIT 8', [])).rows.map(publicOrder),
      recentRecordings: (await db.query(`${recordingSql} ORDER BY r.started_at DESC LIMIT 8`, [])).rows.map(publicRecording) });
  });
  app.get('/api/orders', auth('admin'), async (req, res) => {
    const pattern = safeLike(req.query.q);
    const status = String(req.query.status || '');
    if (status && !['NEW', 'READY', 'PACKING', 'PACKED'].includes(status)) fail(400, 'Status pesanan tidak valid.');
    const where = `WHERE (tracking ILIKE $1 ESCAPE '\\' OR order_number ILIKE $1 ESCAPE '\\' OR buyer ILIKE $1 ESCAPE '\\' OR recipient ILIKE $1 ESCAPE '\\')${status ? ' AND status = $2' : ''}`;
    const params = [pattern, ...(status ? [status] : [])];
    const rows = (await db.query(`SELECT * FROM fulfill.orders ${where} ORDER BY updated_at DESC LIMIT $${params.length + 1}`, [...params, limit(req.query.limit)])).rows;
    const total = (await db.query(`SELECT COUNT(*)::integer AS n FROM fulfill.orders ${where}`, params)).rows[0].n;
    res.json({ orders: rows.map(publicOrder), total });
  });
  app.get('/api/orders/:tracking', auth('admin', 'picker', 'packer'), async (req, res) => res.json({ order: publicOrder(await getOrder(db, req.params.tracking)) }));
  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 } });
  app.post('/api/imports/preview', auth('admin'), importUpload.single('file'), async (req, res) => res.json(await parseImport(req.file)));
  app.post('/api/imports/confirm', auth('admin'), async (req, res) => res.json(await confirmImport(db, req.body?.orders)));

  app.get('/api/users', auth('admin'), async (req, res) => res.json({ users: (await db.query('SELECT * FROM fulfill.users ORDER BY created_at', [])).rows.map(publicUser) }));
  app.post('/api/users', auth('admin'), async (req, res) => res.status(201).json({ user: await createUser(db, req.body || {}) }));
  app.patch('/api/users/:id', auth('admin'), async (req, res) => {
    const result = await transaction(db, async db => {
      const row = (await db.query('SELECT * FROM fulfill.users WHERE id = $1', [req.params.id])).rows[0];
      if (!row) fail(404, 'Pengguna tidak ditemukan.');
      const patch = req.body || {};
      if (typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'Kolom perubahan pengguna tidak valid.');
      if (Object.keys(patch).some(key => !['name', 'password', 'active'].includes(key))) fail(400, 'Kolom perubahan pengguna tidak valid.');
      if ('active' in patch && typeof patch.active !== 'boolean') fail(400, 'Status aktif harus boolean.');
      const active = 'active' in patch ? Number(patch.active) : row.active;
      if (!active && row.role === 'admin' && row.active && (await db.query("SELECT COUNT(*)::integer AS n FROM fulfill.users WHERE role='admin' AND active=1", [])).rows[0].n <= 1) fail(409, 'Minimal satu admin harus tetap aktif.');
      const name = 'name' in patch ? validText(patch.name, 'Nama', 120) : row.name;
      const password = 'password' in patch ? hashPassword(patch.password) : row.password;
      await db.query('UPDATE fulfill.users SET name=$1,password=$2,active=$3 WHERE id=$4', [name, password, active, row.id]);
      if ('password' in patch || !active) await db.query('DELETE FROM fulfill.sessions WHERE user_id=$1', [row.id]);
      return publicUser((await db.query('SELECT * FROM fulfill.users WHERE id=$1', [row.id])).rows[0]);
    });
    res.json({ user: result });
  });

  app.post('/api/picking/:tracking/complete', auth('picker'), async (req, res) => {
    const order = await transaction(db, async db => {
      const row = await getOrder(db, req.params.tracking);
      const checked = req.body?.checked;
      const count = JSON.parse(row.items).length;
      if (!Array.isArray(checked) || checked.length !== count || new Set(checked).size !== count || checked.some(index => !Number.isInteger(index) || index < 0 || index >= count)) fail(400, 'Periksa dan centang seluruh barang sebelum menyelesaikan picking.');
      if (sourceBlocked(row.source_status)) fail(409, 'Pesanan dibatalkan atau belum dibayar dan tidak dapat diproses.');
      if (!['NEW', 'READY'].includes(row.status)) fail(409, 'Pesanan sudah masuk proses packing.');
      const version = req.body?.version;
      if (row.status === 'READY' && row.picked_by === req.user.id && Number.isInteger(version) && (version === row.version || version === row.picked_input_version)) return row;
      if (version !== row.version || !Number.isInteger(version)) fail(409, 'Data pesanan berubah. Muat ulang dan periksa barang kembali.', 'VERSION_CONFLICT');
      if (row.status === 'READY') return row;
      const timestamp = now();
      await db.query("UPDATE fulfill.orders SET status='READY',picked_by=$1,picked_at=$2,picked_input_version=$3,version=version+1,updated_at=$4 WHERE id=$5", [req.user.id, timestamp, version, timestamp, row.id]);
      return await getOrder(db, row.tracking);
    });
    res.json({ order: publicOrder(order) });
  });

  app.get('/api/recordings', auth('admin'), async (req, res) => {
    const pattern = safeLike(req.query.q);
    res.json({ recordings: (await db.query(`${recordingSql} WHERE r.tracking ILIKE $1 ESCAPE '\\' OR r.order_number ILIKE $2 ESCAPE '\\' ORDER BY r.started_at DESC LIMIT 500`, [pattern, pattern])).rows.map(publicRecording) });
  });
  app.post('/api/recordings/start', auth('packer'), async (req, res) => {
    const tracking = validText(req.body?.tracking, 'Resi', 120);
    const station = validText(req.body?.station, 'Stasiun', 100);
    const clientId = validText(req.body?.clientId, 'ID rekaman', 150);
    const result = await transaction(db, async db => {
      const previous = (await db.query('SELECT id,packer_id,tracking FROM fulfill.recordings WHERE client_id=$1', [clientId])).rows[0];
      if (previous) {
        if (previous.packer_id !== req.user.id || previous.tracking !== tracking) fail(409, 'ID rekaman sudah digunakan.');
        return { recording: publicRecording(await getRecording(db, previous.id)), order: publicOrder(await getOrder(db, tracking)) };
      }
      const order = await getOrder(db, tracking);
      if (sourceBlocked(order.source_status)) fail(409, 'Pesanan dibatalkan atau belum dibayar.');
      if (order.status !== 'READY') fail(409, order.status === 'NEW' ? 'Picker harus menyelesaikan pemeriksaan dahulu.' : 'Pesanan sedang atau sudah dipacking.');
      const id = randomUUID(); const timestamp = now();
      await db.query("INSERT INTO fulfill.recordings (id,tracking,order_number,packer_id,station,status,started_at,client_id) VALUES ($1,$2,$3,$4,$5,'RECORDING',$6,$7)", [id, tracking, order.order_number, req.user.id, station, timestamp, clientId]);
      await db.query("UPDATE fulfill.orders SET status='PACKING',version=version+1,updated_at=$1 WHERE id=$2", [timestamp, order.id]);
      return { recording: publicRecording(await getRecording(db, id)), order: publicOrder(await getOrder(db, tracking)) };
    });
    res.json(result);
  });
  const owner = async (req, res, next) => {
    const row = await getRecording(db, req.params.id);
    if (row.packer_id !== req.user.id) fail(403, 'Rekaman hanya dapat diubah oleh packer pemilik.');
    req.recording = row; next();
  };
  const videoUpload = multer({ dest: spoolDir, limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 2, fieldSize: 100 },
    fileFilter(req, file, callback) {
      const mime = file.mimetype.split(';')[0].toLowerCase();
      if (!['video/webm', 'video/mp4'].includes(mime)) return callback(Object.assign(new Error('Format rekaman harus WebM atau MP4.'), { status: 400 }));
      file.mimetype = mime; callback(null, true);
    } });
  app.post('/api/recordings/:id/upload', auth('packer'), owner, async (req, res, next) => {
    const id = req.params.id;
    if (uploads.has(id)) fail(409, 'Rekaman sedang diproses. Tunggu lalu coba ulang.');
    uploads.add(id);
    try {
      // Re-read after reserving the operation: async database calls may interleave.
      const row = await getRecording(db, id);
      req.recording = row;
      if (['SAVED', 'INTERRUPTED'].includes(row.status) && row.drive_file_id) {
        const order = publicOrder(await getOrder(db, row.tracking));
        uploads.delete(id);
        return res.json({ recording: publicRecording(row), order });
      }
      if (row.status !== 'RECORDING') fail(409, 'Rekaman sudah dibatalkan. Mulai rekaman baru.');
      videoUpload.single('video')(req, res, error => {
        if (error) { uploads.delete(id); return next(error); }
        next();
      });
    } catch (error) { uploads.delete(id); throw error; }
  }, async (req, res) => {
    const row = req.recording;
    try {
      if (!req.file) fail(400, 'File rekaman belum disertakan.');
      const duration = Number(req.body?.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 3600) fail(400, 'Durasi rekaman tidak valid.');
      if (!['true', 'false'].includes(req.body?.interrupted)) fail(400, 'Status rekaman terputus harus true atau false.');
      const handle = await open(req.file.path, 'r');
      const header = Buffer.alloc(16);
      try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
      const validMagic = req.file.mimetype === 'video/webm' ? header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : header.subarray(4, 8).toString() === 'ftyp';
      if (req.file.size < 16 || !validMagic) fail(400, 'File tidak memiliki header video yang valid.');
      const file = await driveService.upload({ recordingId: row.id, path: req.file.path, mimeType: req.file.mimetype,
        filename: `${row.tracking.replace(/[^a-zA-Z0-9_-]/g, '_')}_${row.id}.${extensionFor(req.file.mimetype)}` });
      if (!file?.id) fail(502, 'Google Drive belum mengonfirmasi file. Coba unggah ulang.');
      const interrupted = req.body.interrupted === 'true';
      await transaction(db, async db => {
        const current = await getRecording(db, row.id);
        if (current.status !== 'RECORDING') fail(409, 'Status rekaman telah berubah.');
        const timestamp = now();
        await db.query('UPDATE fulfill.recordings SET status=$1,finished_at=$2,duration=$3,bytes=$4,drive_file_id=$5,reason=$6 WHERE id=$7', [interrupted ? 'INTERRUPTED' : 'SAVED', timestamp, duration, req.file.size, file.id, interrupted ? 'Rekaman terputus; lakukan packing ulang.' : null, row.id]);
        await db.query('UPDATE fulfill.orders SET status=$1,version=version+1,updated_at=$2 WHERE tracking=$3', [interrupted ? 'READY' : 'PACKED', timestamp, row.tracking]);
      });
      res.json({ recording: publicRecording(await getRecording(db, row.id)), order: publicOrder(await getOrder(db, row.tracking)) });
    } finally {
      uploads.delete(row.id);
      if (req.file) await unlink(req.file.path).catch(() => {});
    }
  });
  const release = async (req, res, admin) => {
    const id = req.params.id;
    if (uploads.has(id)) fail(409, 'Unggahan sedang berlangsung. Tunggu sampai selesai.');
    uploads.add(id);
    try {
      await transaction(db, async db => {
        const row = await getRecording(db, id);
        if (admin && req.body?.confirm !== true) fail(400, 'Konfirmasi pelepasan rekaman diperlukan.');
        if (row.status === 'FAILED') return;
        if (row.status !== 'RECORDING' || row.drive_file_id) fail(409, 'Rekaman yang sudah tersimpan tidak dapat dibatalkan.');
        const reason = admin ? 'Dilepas admin; rekaman sebelumnya tidak menyelesaikan packing.' : validText(req.body?.reason || 'Dibatalkan packer.', 'Alasan', 500);
        await db.query("UPDATE fulfill.recordings SET status='FAILED',finished_at=$1,reason=$2 WHERE id=$3", [now(), reason, row.id]);
        await db.query("UPDATE fulfill.orders SET status='READY',version=version+1,updated_at=$1 WHERE tracking=$2 AND status='PACKING'", [now(), row.tracking]);
      });
    } finally { uploads.delete(id); }
    res.json({ ok: true });
  };
  app.post('/api/recordings/:id/cancel', auth('packer'), owner, async (req, res) => release(req, res, false));
  app.patch('/api/recordings/:id/release', auth('admin'), async (req, res) => release(req, res, true));
  app.get('/api/recordings/:id/video', auth('admin', 'packer'), async (req, res) => {
    const row = await getRecording(db, req.params.id);
    if (req.user.role !== 'admin' && row.packer_id !== req.user.id) fail(403, 'Rekaman ini milik packer lain.');
    if (!row.drive_file_id) fail(404, 'Video belum tersimpan di Google Drive.');
    const range = req.headers.range;
    if (range && (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 100)) fail(416, 'Rentang video tidak valid.');
    const response = await driveService.media(row.drive_file_id, range);
    if (![200, 206, 416].includes(response.status)) fail(502, 'Video Google Drive belum dapat diakses.');
    res.status(response.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = response.headers.get(name); if (value) res.set(name, value);
    }
    res.set('Content-Disposition', 'inline');
    if (!response.body || response.status === 416) return res.end();
    await pipeline(Readable.fromWeb(response.body), res);
  });
  app.get('/api/integrations/drive/status', auth('admin', 'packer'), async (req, res) => res.json(await driveService.status()));
  app.post('/api/integrations/drive/connect', auth('admin'), async (req, res) => res.json(await driveService.connect(req.user.id)));
  app.get('/api/integrations/drive/callback', auth('admin'), async (req, res) => {
    const destination = outcome => {
      const path = `/admin?tab=drive&drive=${outcome}`;
      return env.APP_ORIGIN ? new URL(path, env.APP_ORIGIN).href : path;
    };
    try {
      if (req.query.error) fail(400, 'Izin Google Drive dibatalkan.');
      await driveService.callback({ code: req.query.code, state: req.query.state, adminId: req.user.id });
      res.redirect(destination('connected'));
    } catch { res.redirect(destination('error')); }
  });
  app.use('/api', async (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
  const frontend = distDir || resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
  if (existsSync(join(frontend, 'index.html'))) {
    app.use(express.static(frontend, { index: false }));
    app.get('/{*path}', async (req, res) => res.sendFile(join(frontend, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file melebihi batas (impor 10 MiB, video 200 MiB).' : 'Berkas unggahan tidak valid.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Data terlalu besar. Pecah impor menjadi beberapa file.' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'JSON tidak valid.' });
    if (error.code === '23505') return res.status(409).json({ error: 'Data sudah digunakan atau proses lain telah memperbaruinya. Muat ulang lalu coba lagi.' });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    if (status === 500) console.error('Operasi server gagal:', error.code || error.name);
    res.status(status).json({ error: status === 500 ? 'Terjadi kesalahan server. Silakan coba lagi.' : error.message, ...(error.code ? { code: error.code } : {}) });
  });
  return app;
}
