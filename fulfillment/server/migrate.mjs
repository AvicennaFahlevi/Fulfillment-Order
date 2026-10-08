import { openDatabase, safeDatabaseError } from './db.mjs';
import { migrate } from './migrations.mjs';

let db;
try {
  db = openDatabase();
  const files = await migrate(db);
  console.log(files.length ? `Migration selesai: ${files.join(', ')}` : 'Schema PostgreSQL sudah terbaru.');
} catch (error) {
  console.error(safeDatabaseError(error));
  process.exitCode = 1;
} finally {
  await db?.end();
}
