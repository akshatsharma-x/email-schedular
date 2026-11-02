import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema.js';

/**
 * Postgres pool + Drizzle handle.
 *
 * `pg` returns BIGINT/NUMERIC as strings by default, which quietly turns counts
 * into strings in JSON responses. COUNT(*) is parsed back to a number here so
 * the API contract stays honest.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  // Fail fast instead of hanging a request forever on a dead database.
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  // An idle client erroring must not take the process down.
  console.error('[db] idle client error', err.message);
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}
