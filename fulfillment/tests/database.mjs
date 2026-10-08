// Never fall back to DATABASE_URL: tests must not use the application's database.
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.mjs';
import { migrate } from '../server/migrations.mjs';

export async function testDatabase({ migrateSchema = true } = {}) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL test server (role requires CREATEDB).');
  const admin = openDatabase({ connectionString });
  const name = `fulfill_test_${randomUUID().replaceAll('-', '')}`;
  let db;
  let created = false;
  let closing;
  const close = () => closing ||= (async () => {
    await db?.end();
    try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await admin.end(); }
  })();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(connectionString);
    url.pathname = `/${name}`;
    db = openDatabase({ connectionString: url.toString() });
    if (migrateSchema) await migrate(db);
    return { db, close, connectionString: url.toString() };
  } catch (error) { await close(); throw error; }
}
