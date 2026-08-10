/**
 * db/migrate.ts
 *
 * Runs pending Drizzle migrations (src/db/migrations/*.sql, generated via
 * `pnpm db:generate`) against DATABASE_URL. Invoked via `pnpm db:migrate`.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closePostgresClient, getPostgresClient } from '../memory/postgresAdapter.js';

const MIGRATIONS_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(): Promise<void> {
  const db = getPostgresClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations()
    .then(() => {
      console.log('Migrations applied successfully.');
      return closePostgresClient();
    })
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      return closePostgresClient().finally(() => process.exit(1));
    });
}
