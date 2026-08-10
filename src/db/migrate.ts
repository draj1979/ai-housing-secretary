/**
 * db/migrate.ts
 *
 * Runs pending Drizzle migrations (src/db/migrations/*.sql, generated via
 * `pnpm db:generate`) against DATABASE_URL. Invoked via `pnpm db:migrate`
 * and by scripts/gcp/remote-deploy.sh (`docker compose run --rm gateway
 * node dist/db/migrate.js`).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadEnvAsync } from '../config/env.js';
import { closePostgresClient, getPostgresClient } from '../memory/postgresAdapter.js';

const MIGRATIONS_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(): Promise<void> {
  const db = getPostgresClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // Resolves SECRETS_SOURCE=gcp secrets into process.env *before*
  // getPostgresClient() (inside runMigrations) does its own bare
  // loadEnv() — this is a real process entry point (HLD Sec 15), same as
  // gateway/index.ts / inboundWorker.ts / broadcastWorker.ts, and needs
  // the same loadEnvAsync() call for the same reason. Confirmed live: a
  // real SECRETS_SOURCE=gcp deploy throws otherwise (JWT_SECRET/
  // FIELD_ENCRYPTION_KEY re-validated against their still-empty
  // plaintext .env placeholders instead of the real Secret Manager
  // values) — see config/env.ts's loadEnvAsync doc comment for the full
  // mechanism (it patches process.env itself, not just its own return
  // value, which is why discarding the return here is fine).
  await loadEnvAsync();
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
