import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { transaction } from './db.mjs';

const defaultDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(db, directory = defaultDirectory) {
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!files.length) throw Object.assign(new Error('File migration PostgreSQL tidak ditemukan.'), { safeMessage: true });
  return transaction(db, async client => {
    await client.query('CREATE SCHEMA IF NOT EXISTS fulfill');
    await client.query('REVOKE ALL ON SCHEMA fulfill FROM PUBLIC');
    await client.query(`CREATE TABLE IF NOT EXISTS fulfill.schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = new Map((await client.query('SELECT name, checksum FROM fulfill.schema_migrations')).rows.map(row => [row.name, row.checksum]));
    const completed = [];
    for (const name of files) {
      const sql = await readFile(join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) throw Object.assign(new Error(`Migration ${name} sudah pernah dijalankan dengan isi berbeda.`), { safeMessage: true });
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO fulfill.schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      completed.push(name);
    }
    return completed;
  });
}
