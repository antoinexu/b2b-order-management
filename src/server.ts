import { createApp } from './app';
import { config } from './config';
import { createPgDatabase } from './db/client';
import { settleBackgroundTasks } from './lib/background';

async function main() {
  const database = createPgDatabase(config.DATABASE_URL);
  await database.migrate();

  const app = createApp({ db: database.db, config });
  const server = app.listen(config.PORT, () => {
    console.log(`B2B Order Management API listening on http://localhost:${config.PORT} (docs: /docs)`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      // Let queued emails go out before the database connection closes.
      settleBackgroundTasks().finally(() => database.close().finally(() => process.exit(0)));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
