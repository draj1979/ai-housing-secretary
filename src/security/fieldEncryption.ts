/**
 * security/fieldEncryption.ts
 *
 * Field-level encryption at rest for resident PII (HLD Sec 15) —
 * `residents.phone_e164` and `residents.emergency_contact`. AES-256-GCM,
 * app-layer (Node's `crypto`), rather than pgcrypto: keeps the encryption
 * format in one typed place this codebase controls, instead of spread
 * across raw SQL in every insert/select that touches these columns.
 *
 * `phone_e164` is also a lookup key (unique per resident, looked up on
 * every inbound WhatsApp message — agent/guardrails.ts, gateway/inboundWorker.ts).
 * AES-GCM is non-deterministic (a fresh random IV per call), so the same
 * phone number encrypts to a different ciphertext every time — correct for
 * "an attacker with DB access can't correlate rows by ciphertext", but it
 * also means the encrypted column can no longer be queried by equality.
 * `hashForLookup` is the fix: a deterministic HMAC-SHA256 "blind index" of
 * the plaintext, stored alongside the ciphertext (`residents.phone_e164_hash`)
 * and used for lookups instead — see tools/residentsTool.ts, which is the
 * *only* place in this codebase allowed to read/write these two columns.
 *
 * The encryption key never appears in ciphertext or the hash — both are
 * useless without `FIELD_ENCRYPTION_KEY` (config/env.ts), which itself
 * only ever comes from `.env` (local dev) or GCP Secret Manager
 * (config/secrets.ts, production) — never committed, same as every other
 * secret in this app (HLD Sec 15).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { Env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32; // AES-256
const IV_LENGTH_BYTES = 12; // GCM standard nonce size
const AUTH_TAG_LENGTH_BYTES = 16;

export interface FieldEncryptionConfig {
  /** 32-byte AES-256 key, base64-encoded (e.g. `openssl rand -base64 32`). */
  keyBase64: string;
}

/** Builds a FieldEncryptionConfig from env — the one place this module reads env. */
export function fieldEncryptionConfigFromEnv(env: Env): FieldEncryptionConfig {
  if (!env.FIELD_ENCRYPTION_KEY) {
    throw new Error('FIELD_ENCRYPTION_KEY is required to encrypt/decrypt resident PII fields.');
  }
  return { keyBase64: env.FIELD_ENCRYPTION_KEY };
}

export interface FieldEncryption {
  /** Encrypts `plaintext`, returning a self-contained base64 blob (iv + auth tag + ciphertext) — no separate columns needed. */
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  /** Deterministic HMAC-SHA256 hex digest of `plaintext` — the "blind index" for equality lookups without decrypting every row. */
  hashForLookup(plaintext: string): string;
}

export function createFieldEncryption(config: FieldEncryptionConfig): FieldEncryption {
  const key = Buffer.from(config.keyBase64, 'base64');
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `FIELD_ENCRYPTION_KEY must base64-decode to ${KEY_LENGTH_BYTES} bytes (AES-256); got ${key.length}.`,
    );
  }

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_LENGTH_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
    },

    decrypt(ciphertext) {
      const raw = Buffer.from(ciphertext, 'base64');
      if (raw.length < IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES) {
        throw new Error(
          'Ciphertext too short to contain an iv + auth tag — wrong key or corrupt data.',
        );
      }
      const iv = raw.subarray(0, IV_LENGTH_BYTES);
      const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
      const encrypted = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    },

    hashForLookup(plaintext) {
      return createHmac('sha256', key).update(plaintext, 'utf8').digest('hex');
    },
  };
}
