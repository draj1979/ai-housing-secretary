import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFieldEncryption, fieldEncryptionConfigFromEnv } from './fieldEncryption.js';
import type { Env } from '../config/env.js';

const KEY_BASE64 = randomBytes(32).toString('base64');

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { FIELD_ENCRYPTION_KEY: KEY_BASE64, ...overrides } as Env;
}

describe('fieldEncryptionConfigFromEnv', () => {
  it('builds a config from env', () => {
    expect(fieldEncryptionConfigFromEnv(makeEnv())).toEqual({ keyBase64: KEY_BASE64 });
  });

  it('throws when FIELD_ENCRYPTION_KEY is missing', () => {
    expect(() => fieldEncryptionConfigFromEnv(makeEnv({ FIELD_ENCRYPTION_KEY: '' }))).toThrow(
      /FIELD_ENCRYPTION_KEY/,
    );
  });
});

describe('createFieldEncryption', () => {
  it('throws when the key does not decode to 32 bytes', () => {
    expect(() =>
      createFieldEncryption({ keyBase64: Buffer.from('too-short').toString('base64') }),
    ).toThrow(/32 bytes/);
  });

  describe('encrypt / decrypt', () => {
    const enc = createFieldEncryption({ keyBase64: KEY_BASE64 });

    it('round-trips a phone number', () => {
      const ciphertext = enc.encrypt('+919820011001');
      expect(ciphertext).not.toContain('+919820011001');
      expect(enc.decrypt(ciphertext)).toBe('+919820011001');
    });

    it('produces different ciphertext for the same plaintext each time (random iv)', () => {
      const a = enc.encrypt('+919820011001');
      const b = enc.encrypt('+919820011001');
      expect(a).not.toBe(b);
      expect(enc.decrypt(a)).toBe('+919820011001');
      expect(enc.decrypt(b)).toBe('+919820011001');
    });

    it('fails to decrypt with the wrong key (auth tag mismatch)', () => {
      const otherEnc = createFieldEncryption({ keyBase64: randomBytes(32).toString('base64') });
      const ciphertext = enc.encrypt('secret-value');
      expect(() => otherEnc.decrypt(ciphertext)).toThrow();
    });

    it('throws on a truncated/corrupt ciphertext', () => {
      expect(() => enc.decrypt(Buffer.from('short').toString('base64'))).toThrow(/too short/);
    });

    it('round-trips an empty string', () => {
      expect(enc.decrypt(enc.encrypt(''))).toBe('');
    });

    it('round-trips unicode content', () => {
      const text = 'Anita Deshmukh — आपातकालीन संपर्क';
      expect(enc.decrypt(enc.encrypt(text))).toBe(text);
    });
  });

  describe('hashForLookup', () => {
    const enc = createFieldEncryption({ keyBase64: KEY_BASE64 });

    it('is deterministic for the same plaintext', () => {
      expect(enc.hashForLookup('+919820011001')).toBe(enc.hashForLookup('+919820011001'));
    });

    it('differs for different plaintext', () => {
      expect(enc.hashForLookup('+919820011001')).not.toBe(enc.hashForLookup('+919820011002'));
    });

    it('differs across keys (the hash alone cannot be used to guess the plaintext without the key)', () => {
      const otherEnc = createFieldEncryption({ keyBase64: randomBytes(32).toString('base64') });
      expect(enc.hashForLookup('+919820011001')).not.toBe(otherEnc.hashForLookup('+919820011001'));
    });

    it('is a 64-character hex digest (SHA-256)', () => {
      expect(enc.hashForLookup('+919820011001')).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
