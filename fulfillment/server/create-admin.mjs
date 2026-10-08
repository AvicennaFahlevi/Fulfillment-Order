import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openDatabase, createAdmin, safeDatabaseError } from './db.mjs';
let db;
let terminal;
try {
  db = openDatabase();
  let username = process.env.ADMIN_USERNAME;
  let name = process.env.ADMIN_NAME;
  let password = process.env.ADMIN_PASSWORD;
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  if (!username || !name || !password) {
    if (!process.stdin.isTTY) throw Object.assign(new Error('Gunakan terminal interaktif atau ADMIN_USERNAME, ADMIN_NAME, ADMIN_PASSWORD.'), { safeMessage: true });
    terminal = createInterface({ input: process.stdin, output, terminal: true });
    username ||= (await terminal.question('Username admin: ')).trim();
    name ||= (await terminal.question('Nama admin: ')).trim();
    if (!password) {
      process.stdout.write('Kata sandi (minimal 12 karakter, input disembunyikan): ');
      muted = true; password = await terminal.question(''); muted = false; process.stdout.write('\n');
      process.stdout.write('Ulangi kata sandi: ');
      muted = true; const confirmation = await terminal.question(''); muted = false; process.stdout.write('\n');
      if (password !== confirmation) throw Object.assign(new Error('Kata sandi tidak sama.'), { safeMessage: true });
    }
  }
  const user = await createAdmin(db, { username, name, password });
  console.log(`Admin ${user.username} berhasil dibuat. Login melalui aplikasi.`);
} catch (error) { console.error(safeDatabaseError(error)); process.exitCode = 1; }
finally { terminal?.close(); await db?.end(); }
