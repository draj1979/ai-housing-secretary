/**
 * config/env.ts
 *
 * Typed, validated environment schema for the AI Housing Society Secretary
 * Assistant (see .env.example and root CLAUDE.md).
 *
 * Two entry points:
 *   - `loadEnv(source)` — synchronous, validates `source` (default
 *     `process.env`) as-is. Used by tests and anywhere secrets are known to
 *     already be resolved (e.g. a Cloud Run/Compute Engine environment that
 *     injects secrets as env vars itself).
 *   - `loadEnvAsync(source)` — the real boot path (HLD Sec 15): resolves
 *     `SECRETS_SOURCE=gcp` secrets from GCP Secret Manager
 *     (config/secrets.ts) *before* validating, so GEMINI_API_KEY,
 *     WHATSAPP_CLOUD_API_TOKEN, DATABASE_URL, JWT_SECRET, and
 *     FIELD_ENCRYPTION_KEY never have to be committed or set as plaintext
 *     env vars in production. Every process entry point
 *     (`gateway/index.ts`, `inboundWorker.ts`, `broadcastWorker.ts`) uses
 *     this, not `loadEnv`, for its own `isMain` bootstrap.
 *
 * `.env` — LOCAL DEV / TEST ONLY (HLD Sec 15). The `dotenv/config` import
 * below loads a `.env` file in the working directory into `process.env` if
 * one exists (a no-op otherwise — safe in production, where none should
 * exist). Never commit a `.env` with real secrets in it (see `.gitignore`
 * and `.env.example`'s placeholder-only values); production sets
 * `SECRETS_SOURCE=gcp` and gets real values from `loadEnvAsync` instead.
 */
import 'dotenv/config';
import { z } from 'zod';
import { resolveSecretsIntoEnv, type SecretManagerClientLike } from './secrets.js';

const envSchema = z.object({
  // App / runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(8080),
  APP_BASE_URL: z.string().url().optional(),
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  // Gemini
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().default('gemini-flash-lite'),

  // WhatsApp Cloud API
  WHATSAPP_CLOUD_API_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  // The secretary's own WhatsApp phone number (E.164) — outbound "to" for
  // escalation/notification sends (HLD Sec 4, 16).
  WHATSAPP_SECRETARY_NUMBER: z.string().optional(),
  // The secretary number's phone_number_id — used for INBOUND routing: a
  // webhook event's toPhoneNumberId matching this means it arrived on the
  // private Human Secretary number, not the public AI Secretary number
  // (WHATSAPP_PHONE_NUMBER_ID), and is routed to the secretary/approval
  // flow instead of the resident agent pipeline (HLD Sec 4, gateway/orchestrator.ts).
  WHATSAPP_SECRETARY_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_SOCIETY_GROUP_ID: z.string().optional(),
  // Overridable so tests/local dev can point the WhatsApp tool at a mock
  // server instead of the real Graph API.
  WHATSAPP_GRAPH_API_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  // Outbound Cloud API retry/backoff (send/upload/download), and how many
  // broadcast recipients are dispatched concurrently — see tools/whatsappTool.ts.
  WHATSAPP_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  WHATSAPP_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(500),
  WHATSAPP_BROADCAST_CONCURRENCY: z.coerce.number().int().positive().default(5),
  // BullMQ worker concurrency for processing queued inbound webhook events
  // (gateway/inboundWorker.ts) — keeps the <5s average response NFR by
  // letting the webhook respond immediately while these run in the background.
  INBOUND_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(5),

  // OpenClaw Gateway session management (HLD Sec 7.1): how long a WhatsApp
  // thread's session (gateway/session.ts, Redis-backed, keyed by phone_e164)
  // stays alive with no activity before the next message starts a fresh one
  // instead of resuming it. Default 30 minutes.
  SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),

  // PostgreSQL
  DATABASE_URL: z.string().min(1),
  // NOT z.coerce.boolean(): that coerces via JS's `Boolean(x)`, so the
  // *string* "false" (env vars are always strings) is truthy and would
  // turn DATABASE_SSL=false in a real .env/shell into `true`. Parse the
  // literal strings instead.
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Redis
  REDIS_URL: z.string().min(1),

  // Vector DB
  VECTOR_DB_PROVIDER: z.enum(['chroma', 'pgvector']).default('pgvector'),
  CHROMA_URL: z.string().optional(),
  CHROMA_COLLECTION: z.string().default('society_knowledge_base'),
  EMBEDDING_MODEL: z.string().default('text-embedding-004'),

  // Auth / security
  JWT_SECRET: z.string().min(1).optional(),
  JWT_EXPIRES_IN: z.string().default('12h'),
  // Field-level encryption at rest for resident PII (HLD Sec 15) —
  // security/fieldEncryption.ts. 32 bytes, base64-encoded (openssl rand
  // -base64 32). Optional at the schema level so non-resident-touching
  // processes (e.g. a future read-only reporting job) don't need it, but
  // tools/residentsTool.ts throws immediately if it's missing when used.
  FIELD_ENCRYPTION_KEY: z.string().min(1).optional(),

  // GCP
  GCP_PROJECT_ID: z.string().optional(),
  GCP_REGION: z.string().default('asia-south1'),
  GCP_COMPUTE_ZONE: z.string().default('asia-south1-a'),
  GCP_STATIC_IP_NAME: z.string().optional(),
  GCP_CLOUD_SQL_INSTANCE_CONNECTION_NAME: z.string().optional(),
  GCP_STORAGE_BUCKET: z.string().optional(),

  // Secret Manager
  SECRETS_SOURCE: z.enum(['env', 'gcp']).default('env'),
  GCP_SECRET_GEMINI_API_KEY: z.string().optional(),
  GCP_SECRET_WHATSAPP_TOKEN: z.string().optional(),
  GCP_SECRET_DATABASE_URL: z.string().optional(),
  GCP_SECRET_JWT_SECRET: z.string().optional(),
  GCP_SECRET_FIELD_ENCRYPTION_KEY: z.string().optional(),

  // Backups
  BACKUP_SCHEDULE_CRON: z.string().default('0 2 * * *'),
  BACKUP_GCS_BUCKET: z.string().optional(),
  // Passphrase scripts/backup.sh encrypts the daily pg_dump with (openssl
  // aes-256-cbc). Declared here (even though the script itself reads it
  // straight from the shell environment, not through this Node schema) so
  // it's discoverable alongside every other secret and can come from GCP
  // Secret Manager the same way (docs/runbooks/backup-restore.md).
  BACKUP_ENCRYPTION_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates `source` as-is — does **not** resolve
 * `SECRETS_SOURCE=gcp` secrets. Throws on startup if required variables
 * are missing or malformed — fail fast rather than run degraded. Prefer
 * `loadEnvAsync` for any real process boot; this stays synchronous for
 * tests and callers that already have fully-resolved config.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

/**
 * The real boot path (HLD Sec 15): resolves GCP Secret Manager secrets
 * (config/secrets.ts) into `source` first when `SECRETS_SOURCE=gcp`, then
 * validates. A no-op secret fetch (i.e. identical to `loadEnv`) whenever
 * `SECRETS_SOURCE` isn't `'gcp'` — the default, local-dev `.env` path.
 *
 * `client` is injectable (defaults to the real `SecretManagerServiceClient`
 * inside `resolveSecretsIntoEnv`) purely so tests can exercise the
 * `SECRETS_SOURCE=gcp` path without a real GCP call — see env.test.ts.
 *
 * When `source` is the default `process.env` (i.e. a real process boot,
 * not a test injecting its own fake source object), the resolved patch
 * is also applied back onto `process.env` itself, not just returned.
 * This is load-bearing, confirmed by a real SECRETS_SOURCE=gcp deploy
 * throwing without it: several call sites elsewhere in this codebase
 * lazily construct a Postgres client via a bare `getPostgresClient()`
 * default-parameter value (memory/postgresAdapter.ts ->
 * `loadEnv()` -> raw `process.env`) rather than threading the already-
 * resolved `Env` this function returns through every layer —
 * `gateway/index.ts`'s `createOpenClawGateway()` calling
 * `createComplaintTool()`/`createSuggestionTool()` with no arguments is
 * one such case. Without this mutation, that inner `loadEnv()` re-
 * validates the *unresolved* `process.env` and throws on any field
 * (JWT_SECRET, FIELD_ENCRYPTION_KEY, ...) that only ever had a value via
 * Secret Manager — even though this function's own caller already has
 * the correctly-resolved `Env` sitting right there, just not passed
 * down. Gated on `source === process.env` specifically so a test that
 * passes its own fake source (see env.test.ts/secrets.test.ts) never
 * leaks a patch into the real global `process.env` and pollutes other
 * tests.
 */
export async function loadEnvAsync(
  source: NodeJS.ProcessEnv = process.env,
  client?: SecretManagerClientLike,
): Promise<Env> {
  const resolved = await resolveSecretsIntoEnv(source, client);
  const env = envSchema.parse(resolved);
  if (source === process.env) {
    Object.assign(process.env, resolved);
  }
  return env;
}
