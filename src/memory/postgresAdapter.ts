/**
 * memory/postgresAdapter.ts
 *
 * PostgreSQL adapter backing the memory layer and resident database
 * (HLD Sec 5, 7.5, 7.6). Uses DATABASE_URL from config/env.ts. Schema lives
 * in /src/db/schema.ts.
 *
 * This adapter is intentionally the only place that constructs a `pg` Pool /
 * Drizzle instance — `db/migrate.ts` and `scripts/seed.ts` both go through
 * it so connection handling (SSL, pooling) stays in one place.
 */
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { loadEnv } from '../config/env.js';
import * as schema from '../db/schema.js';

const { Pool } = pg;

export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: Database | undefined;

/**
 * Returns a lazily-created, process-wide `pg.Pool`. Reused by both the
 * gateway runtime and one-off scripts (migrate/seed) so we don't open a new
 * connection pool per invocation.
 */
export function getPostgresPool(): pg.Pool {
  if (!pool) {
    const env = loadEnv();
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

/** Returns a Drizzle client bound to the shared pool and this repo's schema. */
export function getPostgresClient(): Database {
  if (!db) {
    db = drizzle(getPostgresPool(), { schema });
  }
  return db;
}

/** Closes the shared pool. Call on graceful shutdown or at the end of scripts. */
export async function closePostgresClient(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
