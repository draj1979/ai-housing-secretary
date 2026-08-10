import { describe, expect, it, vi } from 'vitest';
import { loadEnv, loadEnvAsync } from './env.js';

describe('loadEnv', () => {
  it('parses a minimal valid environment with defaults applied', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
    });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(8080);
    expect(env.VECTOR_DB_PROVIDER).toBe('pgvector');
    expect(env.LOG_RETENTION_DAYS).toBe(90);
  });

  it('throws when required variables are missing', () => {
    expect(() => loadEnv({})).toThrow();
  });
});

describe('loadEnvAsync', () => {
  it('behaves exactly like loadEnv when SECRETS_SOURCE is unset (local-dev default)', async () => {
    const env = await loadEnvAsync({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      GEMINI_API_KEY: 'plaintext-dev-key',
    });

    expect(env.GEMINI_API_KEY).toBe('plaintext-dev-key');
  });

  it('resolves SECRETS_SOURCE=gcp secrets before validating, via an injected client', async () => {
    const client = {
      accessSecretVersion: vi
        .fn()
        .mockResolvedValue([{ payload: { data: 'real-gemini-key-from-secret-manager' } }]),
    };

    const env = await loadEnvAsync(
      {
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/test',
        REDIS_URL: 'redis://localhost:6379',
        SECRETS_SOURCE: 'gcp',
        GEMINI_API_KEY: 'stale-plaintext-value-should-be-overwritten',
        GCP_SECRET_GEMINI_API_KEY: 'projects/p/secrets/gemini/versions/latest',
      },
      client,
    );

    expect(env.GEMINI_API_KEY).toBe('real-gemini-key-from-secret-manager');
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: 'projects/p/secrets/gemini/versions/latest',
    });
  });
});
