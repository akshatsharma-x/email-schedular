import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './client.js';
import { logger } from '../lib/logger.js';

/**
 * Minimal forward-only migration runner.
 *
 * Deliberately hand-rolled rather than pulled from an ORM: the SQL in
 * ./migrations stays the readable source of truth for the schema, each file runs
 * exactly once inside a transaction, and there is no codegen step a reviewer has
 * to trust. Concurrent runners are serialised with an advisory lock, so booting
 * the API and the worker at the same time cannot double-apply a migration.
 */

const log = logger.child({ mod: 'migrate' });
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_KEY = 918_273_645; // arbitrary but stable

async function ensureBookkeeping(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureBookkeeping();

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log.info({ file }, 'applying migration');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        log.error({ file, err }, 'migration failed; rolled back');
        throw err;
      }
    }

    if (applied.length === 0) log.info('database already up to date');
    else log.info({ applied }, 'migrations applied');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

// Allow `npm run migrate` as well as programmatic use at boot.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      log.error({ err }, 'migration run failed');
      process.exit(1);
    });
}
