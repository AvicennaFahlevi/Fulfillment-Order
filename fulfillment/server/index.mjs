import { createApp } from './app.mjs';
import { safeDatabaseError } from './db.mjs';

let app;
try {
  const port = Number(process.env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('PORT tidak valid.'), { safeMessage: true });
  app = createApp();
  // Startup requires the migrated schema; starting the server never runs migrations.
  await app.locals.db.query('SELECT id FROM fulfill.users LIMIT 0');
  const server = app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Fulfill tersedia pada port ${port}.`));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => {
      await app.locals.close();
      process.exitCode = 0;
    });
  });
} catch (error) {
  console.error(safeDatabaseError(error));
  await app?.locals.close();
  process.exitCode = 1;
}
