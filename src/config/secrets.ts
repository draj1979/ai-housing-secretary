/**
 * config/secrets.ts
 *
 * GCP Secret Manager resolution (HLD Sec 15: "load secrets from GCP Secret
 * Manager at boot, never from committed files"). `.env` (config/env.ts's
 * `loadEnv`) is the *shape* of configuration and the local-dev path; this
 * file is what makes `SECRETS_SOURCE=gcp` actually replace the plaintext
 * secret values — GEMINI_API_KEY, WHATSAPP_CLOUD_API_TOKEN, DATABASE_URL,
 * JWT_SECRET — with ones fetched from Secret Manager at process start,
 * before `loadEnv`'s Zod validation runs.
 *
 * See CLAUDE.md's "Secrets" section for the local-dev-only warning on
 * `.env`, and .env.example's GCP_SECRET_* vars for the resource-name shape
 * (`projects/<id>/secrets/<name>/versions/latest`).
 */
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

/**
 * `process.env` keys this module may overwrite with a Secret Manager value,
 * each paired with the `GCP_SECRET_*` env var that names *which* secret
 * resource to fetch for it. Anything not in this map is never touched —
 * `SECRETS_SOURCE=gcp` doesn't change how non-secret config (ports,
 * feature flags, ...) is read.
 */
const SECRET_TARGETS: ReadonlyArray<{ envKey: string; resourceNameEnvKey: string }> = [
  { envKey: 'GEMINI_API_KEY', resourceNameEnvKey: 'GCP_SECRET_GEMINI_API_KEY' },
  { envKey: 'WHATSAPP_CLOUD_API_TOKEN', resourceNameEnvKey: 'GCP_SECRET_WHATSAPP_TOKEN' },
  { envKey: 'DATABASE_URL', resourceNameEnvKey: 'GCP_SECRET_DATABASE_URL' },
  { envKey: 'JWT_SECRET', resourceNameEnvKey: 'GCP_SECRET_JWT_SECRET' },
  { envKey: 'FIELD_ENCRYPTION_KEY', resourceNameEnvKey: 'GCP_SECRET_FIELD_ENCRYPTION_KEY' },
];

export interface AccessSecretVersionResult {
  payload?: { data?: string | Uint8Array | null } | null;
}

export interface SecretManagerClientLike {
  accessSecretVersion(request: { name: string }): Promise<[AccessSecretVersionResult]>;
}

/**
 * Adapts the real `SecretManagerServiceClient` to `SecretManagerClientLike`
 * — a thin wrapper rather than a structural type match, so this module's
 * public interface doesn't have to track the SDK's exact (and much wider)
 * response shape.
 */
function realClient(): SecretManagerClientLike {
  const client = new SecretManagerServiceClient();
  return {
    async accessSecretVersion(request) {
      const [response] = await client.accessSecretVersion(request);
      const result: AccessSecretVersionResult = response.payload
        ? { payload: { data: response.payload.data ?? null } }
        : {};
      return [result];
    },
  };
}

/**
 * Fetches every configured secret from GCP Secret Manager and returns a
 * `process.env`-shaped patch — never mutates `source` itself, so callers
 * control exactly when/whether the result is applied (see
 * `resolveSecretsIntoEnv` below).
 *
 * Only fetches secrets whose `GCP_SECRET_*` resource name is actually set
 * in `source` — a deployment that only needs some secrets from Secret
 * Manager (e.g. DB creds via Cloud SQL's own mechanism, everything else
 * plaintext for a low-stakes staging env) doesn't have to configure all of
 * them.
 */
export async function fetchSecretsFromGcp(
  source: NodeJS.ProcessEnv,
  client: SecretManagerClientLike = realClient(),
): Promise<Partial<NodeJS.ProcessEnv>> {
  const patch: Partial<NodeJS.ProcessEnv> = {};

  await Promise.all(
    SECRET_TARGETS.map(async ({ envKey, resourceNameEnvKey }) => {
      const resourceName = source[resourceNameEnvKey];
      if (!resourceName) return;

      const [version] = await client.accessSecretVersion({ name: resourceName });
      const data = version.payload?.data;
      if (data == null) {
        throw new Error(
          `Secret Manager returned no payload for ${resourceNameEnvKey}="${resourceName}" (needed for ${envKey}).`,
        );
      }
      patch[envKey] = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    }),
  );

  return patch;
}

/**
 * Resolves `process.env`-shaped config for the app to start from:
 *   - `SECRETS_SOURCE=gcp` -> fetch every configured secret from GCP
 *     Secret Manager and overlay it onto `source` (Secret Manager wins over
 *     whatever plaintext value happened to also be set — a stale `.env`
 *     value should never silently take precedence over the real secret).
 *   - anything else (including unset, `config/env.ts`'s default) -> `source`
 *     unchanged, i.e. `.env` / real environment variables — the local-dev
 *     path (see CLAUDE.md's "Secrets" section for why this is dev-only).
 *
 * Deliberately returns a *new* object rather than mutating `process.env`,
 * so `loadEnv(await resolveSecretsIntoEnv())` stays a pure function of its
 * input, same as every other config loader in this codebase.
 */
export async function resolveSecretsIntoEnv(
  source: NodeJS.ProcessEnv = process.env,
  client?: SecretManagerClientLike,
): Promise<NodeJS.ProcessEnv> {
  if (source.SECRETS_SOURCE !== 'gcp') return source;

  const patch = await fetchSecretsFromGcp(source, client);
  return { ...source, ...patch };
}
