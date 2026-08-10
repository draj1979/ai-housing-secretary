import { describe, expect, it, vi } from 'vitest';
import {
  fetchSecretsFromGcp,
  resolveSecretsIntoEnv,
  type AccessSecretVersionResult,
  type SecretManagerClientLike,
} from './secrets.js';

function makeClient(values: Record<string, string>): SecretManagerClientLike {
  return {
    accessSecretVersion: vi.fn(
      async ({ name }: { name: string }): Promise<[AccessSecretVersionResult]> => {
        const data = values[name];
        if (data === undefined) throw new Error(`No fake secret configured for "${name}".`);
        return [{ payload: { data } }];
      },
    ),
  };
}

describe('fetchSecretsFromGcp', () => {
  it('fetches only the secrets whose GCP_SECRET_* resource name is set', async () => {
    const client = makeClient({
      'projects/p/secrets/gemini/versions/latest': 'gemini-secret-value',
    });

    const patch = await fetchSecretsFromGcp(
      { GCP_SECRET_GEMINI_API_KEY: 'projects/p/secrets/gemini/versions/latest' },
      client,
    );

    expect(patch).toEqual({ GEMINI_API_KEY: 'gemini-secret-value' });
  });

  it('fetches every configured secret in parallel', async () => {
    const client = makeClient({
      'projects/p/secrets/gemini/versions/latest': 'gemini-value',
      'projects/p/secrets/whatsapp/versions/latest': 'whatsapp-value',
      'projects/p/secrets/db/versions/latest': 'postgresql://db',
      'projects/p/secrets/jwt/versions/latest': 'jwt-value',
      'projects/p/secrets/field-key/versions/latest': 'field-key-value',
    });

    const patch = await fetchSecretsFromGcp(
      {
        GCP_SECRET_GEMINI_API_KEY: 'projects/p/secrets/gemini/versions/latest',
        GCP_SECRET_WHATSAPP_TOKEN: 'projects/p/secrets/whatsapp/versions/latest',
        GCP_SECRET_DATABASE_URL: 'projects/p/secrets/db/versions/latest',
        GCP_SECRET_JWT_SECRET: 'projects/p/secrets/jwt/versions/latest',
        GCP_SECRET_FIELD_ENCRYPTION_KEY: 'projects/p/secrets/field-key/versions/latest',
      },
      client,
    );

    expect(patch).toEqual({
      GEMINI_API_KEY: 'gemini-value',
      WHATSAPP_CLOUD_API_TOKEN: 'whatsapp-value',
      DATABASE_URL: 'postgresql://db',
      JWT_SECRET: 'jwt-value',
      FIELD_ENCRYPTION_KEY: 'field-key-value',
    });
  });

  it('decodes a Uint8Array payload as utf8', async () => {
    const client: SecretManagerClientLike = {
      accessSecretVersion: vi
        .fn()
        .mockResolvedValue([{ payload: { data: new TextEncoder().encode('bytes-value') } }]),
    };

    const patch = await fetchSecretsFromGcp(
      { GCP_SECRET_GEMINI_API_KEY: 'projects/p/secrets/gemini/versions/latest' },
      client,
    );

    expect(patch.GEMINI_API_KEY).toBe('bytes-value');
  });

  it('throws if Secret Manager returns no payload', async () => {
    const client: SecretManagerClientLike = {
      accessSecretVersion: vi.fn().mockResolvedValue([{ payload: undefined }]),
    };

    await expect(
      fetchSecretsFromGcp(
        { GCP_SECRET_GEMINI_API_KEY: 'projects/p/secrets/gemini/versions/latest' },
        client,
      ),
    ).rejects.toThrow(/no payload/);
  });

  it('returns an empty patch when no GCP_SECRET_* vars are set', async () => {
    const client = makeClient({});
    const patch = await fetchSecretsFromGcp({}, client);
    expect(patch).toEqual({});
    expect(client.accessSecretVersion).not.toHaveBeenCalled();
  });
});

describe('resolveSecretsIntoEnv', () => {
  it('returns source unchanged when SECRETS_SOURCE is not "gcp"', async () => {
    const source = { SECRETS_SOURCE: 'env', GEMINI_API_KEY: 'plain-key' };
    const client = makeClient({});

    const result = await resolveSecretsIntoEnv(source, client);

    expect(result).toBe(source);
    expect(client.accessSecretVersion).not.toHaveBeenCalled();
  });

  it('overlays fetched secrets onto source, winning over a stale plaintext value', async () => {
    const client = makeClient({ 'projects/p/secrets/gemini/versions/latest': 'real-secret-key' });
    const source = {
      SECRETS_SOURCE: 'gcp',
      GEMINI_API_KEY: 'stale-plaintext-key',
      GCP_SECRET_GEMINI_API_KEY: 'projects/p/secrets/gemini/versions/latest',
    };

    const result = await resolveSecretsIntoEnv(source, client);

    expect(result.GEMINI_API_KEY).toBe('real-secret-key');
    expect(result).not.toBe(source); // never mutates the input
    expect(source.GEMINI_API_KEY).toBe('stale-plaintext-key'); // input untouched
  });
});
