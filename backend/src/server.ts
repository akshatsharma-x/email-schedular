import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { closeRedis } from './lib/redis.js';
import { closeQueues } from './queue/queues.js';
import { closeEvents } from './realtime/events.js';
import { ensureIndex } from './search/elastic.js';

const log = logger.child({ proc: 'api' });

/**
 * API process.
 *
 * Boot order matters: migrations before anything touches a table, then the
 * search index (best-effort), then listen. Elasticsearch failing to prepare is
 * logged and ignored -- search falls back to Postgres and the API still serves.
 */
async function main(): Promise<void> {
  await runMigrations();
  await ensureIndex();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    log.info(
      {
        port: env.PORT,
        frontend: env.FRONTEND_URL,
        bullBoard: env.BULLBOARD_ENABLED ? env.BULLBOARD_PATH : 'disabled',
        devAuthBypass: env.DEV_AUTH_BYPASS,
      },
      'api listening',
    );
  });

  // SSE connections are long-lived; without this they are torn down at 5s.
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down api');
    server.close();
    await closeEvents();
    await closeQueues();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err }, 'api failed to start');
  process.exit(1);
});
