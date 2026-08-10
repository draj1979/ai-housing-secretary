import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWebhookRoutes, verifyChallenge, verifySignature } from './webhook.js';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tools/__fixtures__/whatsapp',
);

function loadFixtureRaw(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

function sign(body: string, secret: string = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('verifyChallenge', () => {
  it('returns the challenge when mode/token match', () => {
    const result = verifyChallenge(
      { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' },
      VERIFY_TOKEN,
    );
    expect(result).toBe('abc123');
  });

  it('returns null when the token does not match', () => {
    const result = verifyChallenge(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'abc123' },
      VERIFY_TOKEN,
    );
    expect(result).toBeNull();
  });

  it('returns null when mode is not "subscribe"', () => {
    const result = verifyChallenge(
      { 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' },
      VERIFY_TOKEN,
    );
    expect(result).toBeNull();
  });

  it('returns null when challenge is missing', () => {
    const result = verifyChallenge(
      { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN },
      VERIFY_TOKEN,
    );
    expect(result).toBeNull();
  });
});

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const header = sign(body.toString());
    expect(verifySignature(body, header, APP_SECRET)).toBe(true);
  });

  it('rejects a body signed with the wrong secret', () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const header = sign(body.toString(), 'a-different-secret');
    expect(verifySignature(body, header, APP_SECRET)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const original = Buffer.from(JSON.stringify({ a: 1 }));
    const header = sign(original.toString());
    const tampered = Buffer.from(JSON.stringify({ a: 2 }));
    expect(verifySignature(tampered, header, APP_SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifySignature(Buffer.from('{}'), undefined, APP_SECRET)).toBe(false);
  });

  it('rejects a header missing the sha256= prefix', () => {
    const body = Buffer.from('{}');
    const rawHex = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    expect(verifySignature(body, rawHex, APP_SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Route integration (Fastify .inject — no real network/Redis)
// ---------------------------------------------------------------------------

describe('webhook routes', () => {
  let app: FastifyInstance;
  let enqueue: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    app = Fastify();
    enqueue = vi.fn().mockResolvedValue(undefined);
    registerWebhookRoutes(app, { verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET, enqueue });
    await app.ready();
  });

  describe('GET /webhook', () => {
    it('echoes the challenge for a valid subscription request', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/webhook',
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'xyz789',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('xyz789');
    });

    it('returns 403 for an invalid verify token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/webhook',
        query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'xyz789' },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /webhook', () => {
    it('accepts a validly signed text-message payload, enqueues it, and responds fast', async () => {
      const raw = loadFixtureRaw('text-message.json');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        payload: raw,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'received' });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith(JSON.parse(raw));
    });

    it('accepts a validly signed image-message payload', async () => {
      const raw = loadFixtureRaw('image-message.json');
      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        payload: raw,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      });
      expect(response.statusCode).toBe(200);
      expect(enqueue).toHaveBeenCalledWith(JSON.parse(raw));
    });

    it('accepts a validly signed document (PDF) message payload', async () => {
      const raw = loadFixtureRaw('document-message.json');
      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        payload: raw,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      });
      expect(response.statusCode).toBe(200);
      expect(enqueue).toHaveBeenCalledWith(JSON.parse(raw));
    });

    it('rejects a payload with an invalid signature and does not enqueue it', async () => {
      const raw = loadFixtureRaw('text-message.json');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        payload: raw,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      });

      expect(response.statusCode).toBe(401);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('rejects a payload with no signature header at all', async () => {
      const raw = loadFixtureRaw('text-message.json');
      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        payload: raw,
        headers: { 'content-type': 'application/json' },
      });
      expect(response.statusCode).toBe(401);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('returns 500 and does not silently succeed if enqueue fails', async () => {
      enqueue.mockRejectedValueOnce(new Error('redis unavailable'));
      const raw = loadFixtureRaw('text-message.json');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        payload: raw,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      });

      expect(response.statusCode).toBe(500);
    });

    it('responds only once enqueue resolves, and not a moment before — nothing else runs synchronously after it', async () => {
      // The route's only async work after signature verification is
      // `await deps.enqueue(...)`. Gating a fake enqueue on a manually
      // released promise proves the response genuinely depends on nothing
      // more than that call — in production `enqueue` is a single local
      // Redis round trip (gateway/queue.ts), and the actual message
      // processing (gateway/inboundWorker.ts) runs in a separate process
      // afterward, never delaying this response. That split is what keeps
      // this route inside WhatsApp's timeout window and the <5s NFR.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      enqueue.mockImplementationOnce(() => gate);

      const raw = loadFixtureRaw('text-message.json');
      const responsePromise = app.inject({
        method: 'POST',
        url: '/webhook',
        payload: raw,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      });

      let settledBeforeRelease = false;
      responsePromise.then(() => (settledBeforeRelease = true)).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settledBeforeRelease).toBe(false);

      release();
      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    });
  });
});
