import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { testDatabase } from './database.mjs';
import { migrate } from '../server/migrations.mjs';
import { createApp } from '../server/app.mjs';
import { openDatabase, transaction, safeDatabaseError } from '../server/db.mjs';

test('migration is serialized, repeatable and preserves existing rows', async t => {
  const database = await testDatabase({ migrateSchema: false });
  t.after(database.close);
  const results = await Promise.all([migrate(database.db), migrate(database.db)]);
  assert.deepEqual(results.map(files => files.length).sort(), [0, 1]);
  const rows = (await database.db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='fulfill' ORDER BY table_name")).rows;
  assert.deepEqual(rows.map(row => row.table_name), ['orders', 'recordings', 'schema_migrations', 'sessions', 'users']);
  await database.db.query("INSERT INTO fulfill.users VALUES ('preserved','Preserved','preserved','hash','admin',1,'2026-01-01T00:00:00.000Z')");
  assert.deepEqual(await migrate(database.db), []);
  assert.equal((await database.db.query('SELECT count(*)::integer AS n FROM fulfill.users')).rows[0].n, 1);
  assert.equal((await database.db.query("SELECT has_schema_privilege('public', 'fulfill', 'USAGE') AS allowed")).rows[0].allowed, false);
});

test('failed migration rolls back DDL and changed applied migration is rejected', async t => {
  const database = await testDatabase({ migrateSchema: false });
  t.after(database.close);
  const directory = await mkdtemp(join(tmpdir(), 'fulfill-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
  await writeFile(join(directory, '001_initial.sql'), source);
  await writeFile(join(directory, '002_broken.sql'), 'CREATE TABLE fulfill.should_rollback (id INTEGER); SELECT * FROM fulfill.missing_table;');
  await assert.rejects(migrate(database.db, directory), { code: '42P01' });
  assert.equal((await database.db.query("SELECT to_regnamespace('fulfill') AS schema")).rows[0].schema, null);
  await rm(join(directory, '002_broken.sql'));
  await migrate(database.db, directory);
  await writeFile(join(directory, '001_initial.sql'), source + '\n-- edited\n');
  await assert.rejects(migrate(database.db, directory), /isi berbeda/);
});

test('async transaction rolls back writes after an awaited operation fails', async t => {
  const database = await testDatabase();
  t.after(database.close);
  await assert.rejects(transaction(database.db, async client => {
    await client.query("INSERT INTO fulfill.users VALUES ('rollback','Rollback','rollback','hash','admin',1,'2026-01-01')");
    await client.query('SELECT 1');
    throw new Error('intentional rollback');
  }), /intentional rollback/);
  assert.equal((await database.db.query('SELECT count(*)::integer AS n FROM fulfill.users')).rows[0].n, 0);
  await assert.rejects(database.db.query("INSERT INTO fulfill.sessions VALUES ('invalid','missing',9999999999999)"), { code: '23503' });
});

test('health checks actual PostgreSQL and returns 503 without connection details when unavailable', async t => {
  const database = await testDatabase();
  const dataDir = await mkdtemp(join(tmpdir(), 'fulfill-health-'));
  const app = createApp({ database: database.db, dataDir, env: {} });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/health`;
  const healthy = await fetch(endpoint);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true, backend: 'ok', database: 'connected' });
  await database.close();
  const unavailable = await fetch(endpoint, { headers: { Cookie: `fulfill_session=${'a'.repeat(64)}` } });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ok: false, backend: 'ok', database: 'unavailable' });
});

test('configuration rejects missing URLs and does not expose credentials in database errors', async () => {
  assert.throws(() => openDatabase({ connectionString: '' }), /DATABASE_URL/);
  assert.throws(() => openDatabase({ connectionString: 'https://invalid.example' }), /postgres/);
  const error = Object.assign(new Error('postgresql://secret:password@host/db'), { code: 'ECONNREFUSED' });
  assert.doesNotMatch(safeDatabaseError(error), /secret|password|host\/db/);
  const secure = openDatabase({ connectionString: 'postgresql://example:example@db.example.invalid/db?sslmode=require' });
  assert.equal(new URL(secure.options.connectionString).searchParams.get('sslmode'), 'verify-full');
  await secure.end();
});

test('migration CLI, admin CLI and production startup use the same PostgreSQL configuration', async t => {
  const database = await testDatabase({ migrateSchema: false });
  const dataDir = await mkdtemp(join(tmpdir(), 'fulfill-cli-'));
  t.after(async () => { await database.close(); await rm(dataDir, { recursive: true, force: true }); });
  const password = randomBytes(24).toString('hex');
  const env = { ...process.env, DATABASE_URL: database.connectionString, DATA_DIR: dataDir,
    ADMIN_NAME: 'CLI Test', ADMIN_USERNAME: 'cli-admin', ADMIN_PASSWORD: password };
  const run = async args => {
    const child = spawn(process.execPath, args, { env });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    assert.ok(!output.includes(password));
    return output;
  };
  assert.match(await run(['server/migrate.mjs']), /Migration selesai/);
  assert.match(await run(['server/migrate.mjs']), /sudah terbaru/);
  assert.match(await run(['server/create-admin.mjs']), /berhasil dibuat/);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['server/index.mjs'], { env: { ...env, PORT: String(port), HOST: '127.0.0.1' } });
  let output = '';
  server.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.kill(); reject(new Error('Production startup timed out')); }, 10000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Production startup exited (${code}): ${output}`)); });
    server.stdout.on('data', data => {
      output += data;
      if (output.includes(`Fulfill tersedia pada port ${port}.`)) { clearTimeout(timer); resolve(); }
    });
  });
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).database, 'connected');
  // Verify the CLI-created account through the production HTTP login contract.
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cli-admin', password }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.role, 'admin');
  const sessions = (await database.db.query('SELECT expires_at FROM fulfill.sessions')).rows;
  assert.equal(sessions.length, 1);
  assert.ok(Number(sessions[0].expires_at) > Date.now());
});
