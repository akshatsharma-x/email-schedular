import { asc, gt } from 'drizzle-orm';
import { closeDb, db } from '../db/client.js';
import { emailJobs } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { ensureIndex } from '../search/elastic.js';
import { indexEmailsBulk } from '../search/indexer.js';
import { markIndexed } from '../queue/repository.js';

const log = logger.child({ script: 'reindex' });

/**
 * Rebuilds the Elasticsearch index from Postgres.
 *
 *   npm run search:reindex
 *
 * This is what makes "ES is a disposable read optimisation" true rather than
 * aspirational: emails indexed while ES was down, or lost when the index was
 * deleted, are restored from the durable ledger. Keyset pagination (not OFFSET)
 * keeps it O(n) over millions of rows.
 */
async function main(): Promise<void> {
  const ready = await ensureIndex();
  if (!ready) {
    log.error('elasticsearch is not reachable; nothing to do');
    process.exit(1);
  }

  let lastId = '00000000-0000-0000-0000-000000000000';
  let total = 0;
  const BATCH = 500;

  for (;;) {
    const rows = await db
      .select()
      .from(emailJobs)
      .where(gt(emailJobs.id, lastId))
      .orderBy(asc(emailJobs.id))
      .limit(BATCH);

    if (rows.length === 0) break;

    const indexed = await indexEmailsBulk(rows);
    await markIndexed(rows.map((r) => r.id));
    total += indexed;
    lastId = rows[rows.length - 1]!.id;
    log.info({ batch: rows.length, total }, 'reindexed batch');
  }

  log.info({ total }, 'reindex complete');
  await closeDb();
}

main().catch((err) => {
  log.error({ err }, 'reindex failed');
  process.exit(1);
});
