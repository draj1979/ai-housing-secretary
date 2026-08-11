/**
 * gateway/webhook.ts
 *
 * HTTPS webhook entrypoint that receives inbound WhatsApp Cloud API events
 * (HLD Sec 4, 8) and hands them to the OpenClaw Gateway for processing.
 *
 *   - GET  — Meta's webhook verification handshake (hub.mode / hub.verify_token
 *     / hub.challenge, checked against WHATSAPP_VERIFY_TOKEN).
 *   - POST — validates X-Hub-Signature-256 against WHATSAPP_APP_SECRET, then
 *     enqueues the raw payload (gateway/queue.ts, BullMQ over Redis) and
 *     responds immediately. Actual processing happens asynchronously in
 *     gateway/inboundWorker.ts, which is what keeps this route's response
 *     time well inside WhatsApp's timeout window and the <5s average
 *     response NFR (HLD Sec 17) — the enqueue itself is a single local Redis
 *     round trip, not the work.
 *
 * Deliberately takes `WebhookDeps` rather than reading env/building a queue
 * itself (see `createWebhookDepsFromEnv` for the one place that does) — the
 * route logic and its signature/challenge verification are then testable
 * with an in-memory `enqueue`, no Redis required (see webhook.test.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { enqueueInboundWebhookPayload } from './queue.js';

export interface WebhookDeps {
  verifyToken: string;
  appSecret: string;
  enqueue: (payload: unknown) => Promise<void>;
  logger?: Logger;
  /** Route path both GET and POST are registered on. Default `/webhook`. */
  path?: string;
}

/**
 * Validates Meta's webhook-verification GET request. Returns the challenge
 * string to echo back on success, or `null` if the request should be
 * rejected (wrong mode, wrong token, or a malformed/missing challenge).
 * Pure — see webhook.test.ts.
 */
export function verifyChallenge(
  query: Record<string, unknown>,
  verifyToken: string,
): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === verifyToken && typeof challenge === 'string') {
    return challenge;
  }
  return null;
}

/**
 * Validates the `X-Hub-Signature-256` header against the raw request body
 * using WHATSAPP_APP_SECRET, per Meta's webhook signing spec — HMAC-SHA256
 * of the exact request bytes, hex-encoded, prefixed `sha256=`. Uses a
 * timing-safe comparison. Pure — see webhook.test.ts.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;

  const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');

  if (expected.length !== provided.length) return false; // timingSafeEqual requires equal-length buffers
  return timingSafeEqual(expected, provided);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Registers the GET (verification) and POST (event intake) webhook routes
 * — inside an *encapsulated* child context (`app.register(async (instance) => ...)`,
 * not directly on `app`), so the raw-buffer `application/json` content-type
 * parser below only applies to these two routes. Confirmed live: getting
 * this wrong (calling `app.addContentTypeParser` directly on the shared
 * top-level instance, as an earlier version of this function did) silently
 * broke JSON body parsing for *every other* route on the same app —
 * gateway/adminRoutes.ts's `POST /admin/escalations/:ref/status` and
 * gateway/adminResidentsRoutes.ts's `POST /admin/residents` would each
 * receive a raw `Buffer` as `request.body` instead of a parsed object
 * whenever this file's routes were also registered on the same instance
 * (i.e. every real deployment, since gateway/index.ts always registers
 * both) — invisible in either route's own unit tests, since those each
 * build a bare `Fastify()` instance that never also registers this file's
 * routes.
 */
export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookDeps): void {
  const routePath = deps.path ?? '/webhook';

  // Registration is synchronous from this function's own caller's point of
  // view (matches every other `register*Routes` function in gateway/ —
  // none of them are awaited at the call site); Fastify resolves the
  // plugin during `app.ready()`/the first `.listen()`/`.inject()` call,
  // same as any other `app.register(...)`.
  void app.register(async (instance) => {
    // Capture the raw bytes instead of letting Fastify parse JSON for us —
    // signature verification must hash the exact bytes Meta signed, and
    // parsing-then-reserializing is not guaranteed to reproduce them
    // byte-for-byte. Scoped to `instance` (this plugin's encapsulated
    // context), not `app` — see this function's own doc comment for why
    // that distinction is load-bearing.
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    instance.get(routePath, async (request, reply) => {
      const challenge = verifyChallenge(request.query as Record<string, unknown>, deps.verifyToken);
      if (challenge === null) {
        return reply.code(403).send('Forbidden');
      }
      return reply.code(200).send(challenge);
    });

    instance.post(routePath, async (request, reply) => {
      const log = deps.logger ?? request.log;
      const rawBody = request.body as Buffer;
      const signature = firstHeaderValue(request.headers['x-hub-signature-256']);

      if (!verifySignature(rawBody, signature, deps.appSecret)) {
        log.warn('Rejected WhatsApp webhook POST: invalid or missing X-Hub-Signature-256.');
        return reply.code(401).send({ error: 'invalid signature' });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        log.warn('Rejected WhatsApp webhook POST: body is not valid JSON.');
        return reply.code(400).send({ error: 'invalid JSON' });
      }

      try {
        await deps.enqueue(payload);
      } catch (err) {
        // Non-2xx here makes Meta retry the delivery — preferable to
        // silently losing an event we failed to even queue.
        log.error({ err }, 'Failed to enqueue inbound WhatsApp webhook payload.');
        return reply.code(500).send({ error: 'failed to queue event' });
      }

      return reply.code(200).send({ status: 'received' });
    });
  });
}

/** Builds real `WebhookDeps` — env-backed verify token/app secret, BullMQ-backed enqueue. */
export function createWebhookDepsFromEnv(env: Env): WebhookDeps {
  if (!env.WHATSAPP_VERIFY_TOKEN) {
    throw new Error('WHATSAPP_VERIFY_TOKEN is required to register the WhatsApp webhook.');
  }
  if (!env.WHATSAPP_APP_SECRET) {
    throw new Error('WHATSAPP_APP_SECRET is required to register the WhatsApp webhook.');
  }
  return {
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    appSecret: env.WHATSAPP_APP_SECRET,
    enqueue: (payload) => enqueueInboundWebhookPayload(env, payload),
  };
}
