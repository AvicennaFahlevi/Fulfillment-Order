import { Pool } from 'pg';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export const now = () => new Date().toISOString();
export function fail(status, message, code) { const error = new Error(message); error.status = status; error.code = code; throw error; }
// Application queries are parameterized and schema-qualified for Supabase/poolers.
export function openDatabase({ connectionString = process.env.DATABASE_URL } = {}) {
  if (!connectionString) throw Object.assign(new Error('DATABASE_URL belum diisi di .env server.'), { safeMessage: true });
  let url;
  try { url = new URL(connectionString); } catch { throw Object.assign(new Error('DATABASE_URL harus berupa URL PostgreSQL yang valid.'), { safeMessage: true }); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw Object.assign(new Error('DATABASE_URL harus menggunakan postgres:// atau postgresql://.'), { safeMessage: true });
  }
  // pg's legacy sslmode=require can skip certificate verification. Always verify TLS.
  const mode = url.searchParams.get('sslmode');
  if (['require', 'prefer', 'verify-ca', 'no-verify'].includes(mode)) url.searchParams.set('sslmode', 'verify-full');
  if (!mode && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.searchParams.set('sslmode', 'verify-full');
  const db = new Pool({ connectionString: url.toString(), max: 10, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'fulfill' });
  // Idle pool errors must not terminate the server or log credentials/connection strings.
  db.on('error', () => console.error('Koneksi PostgreSQL terputus; pool akan mencoba koneksi baru.'));
  return db;
}
export function safeDatabaseError(error) {
  if (error.safeMessage || (error.status >= 400 && error.status < 500)) return error.message;
  const code = /^[A-Z0-9_]{1,50}$/.test(error.code || '') ? ` (${error.code})` : '';
  return `Operasi PostgreSQL gagal${code}. Periksa DATABASE_URL, TLS, jaringan, dan jalankan npm run db:migrate.`;
}
export async function transaction(db, action) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Preserve SQLite BEGIN IMMEDIATE behavior for short business transactions.
    // The transaction-scoped lock also works through Supabase transaction pooling.
    await client.query("SELECT pg_advisory_xact_lock(18740321, 1)");
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail(400, 'Kata sandi harus berisi 12–128 karakter.');
}
export function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt, expected] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export function publicUser(row) {
  return { id: row.id, name: row.name, username: row.username, role: row.role, active: Boolean(row.active) };
}
export function validText(value, label, max = 200, required = true) {
  if (typeof value !== 'string') fail(400, `${label} harus berupa teks.`);
  const text = value.trim();
  if ((required && !text) || text.length > max || /[\x00-\x1f\x7f]/.test(text)) fail(400, `${label} tidak valid.`);
  return text;
}
export async function createAdmin(db, { name, username, password }) {
  return createUser(db, { name, username, password, role: 'admin' });
}
export async function createUser(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'username', 'password', 'role'].includes(key))) fail(400, 'Kolom pengguna tidak valid.');
  let { name, username, password, role } = input;
  name = validText(name, 'Nama', 120);
  username = validText(username, 'Username', 60).toLowerCase();
  if (!/^[a-z0-9._-]{3,60}$/.test(username)) fail(400, 'Username harus 3–60 huruf, angka, titik, garis bawah, atau tanda hubung.');
  if (!['admin', 'picker', 'packer'].includes(role)) fail(400, 'Peran tidak valid.');
  if ((await db.query('SELECT id FROM fulfill.users WHERE username = $1', [username])).rows[0]) fail(409, 'Username sudah digunakan.');
  const user = { id: randomUUID(), name, username, password: hashPassword(password), role, active: 1, created_at: now() };
  await db.query('INSERT INTO fulfill.users (id,name,username,password,role,active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [user.id, name, username, user.password, role, 1, user.created_at]);
  return publicUser(user);
}
export function publicOrder(row) {
  return { id: row.id, tracking: row.tracking, orderNumber: row.order_number, buyer: row.buyer, recipient: row.recipient,
    sourceStatus: row.source_status, status: row.status, items: JSON.parse(row.items), version: row.version,
    pickedBy: row.picked_by, pickedAt: row.picked_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function publicRecording(row) {
  return { id: row.id, tracking: row.tracking, orderNumber: row.order_number, packerId: row.packer_id,
    packerName: row.packer_name, station: row.station, status: row.status, startedAt: row.started_at,
    finishedAt: row.finished_at, duration: row.duration, bytes: Number(row.bytes), driveFileId: row.drive_file_id,
    videoUrl: row.drive_file_id ? `/api/recordings/${row.id}/video` : null, reason: row.reason, clientId: row.client_id };
}
export async function getOrder(db, tracking) {
  const row = (await db.query('SELECT * FROM fulfill.orders WHERE tracking = $1', [tracking])).rows[0];
  if (!row) fail(404, 'Resi belum ditemukan. Minta admin mengimpor pesanan.');
  return row;
}
export const recordingSql = 'SELECT r.*, u.name AS packer_name FROM fulfill.recordings r JOIN fulfill.users u ON u.id = r.packer_id';
export async function getRecording(db, id) {
  const row = (await db.query(`${recordingSql} WHERE r.id = $1`, [id])).rows[0];
  if (!row) fail(404, 'Rekaman tidak ditemukan.');
  return row;
}
export function sourceBlocked(status) {
  return /cancel|dibatalkan|batal|unpaid|belum\s*(di)?bayar|menunggu\s*(pembayaran|bayar)|to\s*pay|(?:pending|awaiting)\s*payment|not\s*paid|un[- ]paid/i.test(status);
}
