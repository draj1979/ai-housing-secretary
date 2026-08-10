/**
 * gateway/queue.ts
 *
 * BullMQ queue the webhook (gateway/webhook.ts) pushes raw inbound WhatsApp
 * webhook payloads onto, and gateway/inboundWorker.ts consumes from. This is
 * what lets the webhook respond within WhatsApp's timeout window instead of
 * processing inline — enqueueing is a local Redis round trip (milliseconds),
 * the actual processing (memory writes, eventually intent detection) happens
 * out-of-band, keeping the <5s average response NFR (HLD Sec 17).
 */
import { Queue, type ConnectionOptions } from 'bullmq';
import type { Env } from '../config/env.js';

export const INBOUND_WHATSAPP_QUEUE_NAME = 'whatsapp-inbound';

export interface InboundWebhookJobData {
  payload: unknown;
  receivedAt: string;
}

let queue: Queue<InboundWebhookJobData> | undefined;

function connectionFromEnv(env: Env): ConnectionOptions {
  return { url: env.REDIS_URL } as ConnectionOptions;
}

/** Lazily-created, process-wide BullMQ Queue producer. */
export function getInboundQueue(env: Env): Queue<InboundWebhookJobData> {
  if (!queue) {
    queue = new Queue<InboundWebhookJobData>(INBOUND_WHATSAPP_QUEUE_NAME, {
      connection: connectionFromEnv(env),
      defaultJobOptions: {
        // A few retries at the queue level too — belt-and-braces alongside
        // the WhatsApp tool's own outbound retry logic; this covers
        // transient Redis/worker restarts, not Cloud API rate limits.
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 1000 },
      },
    });
  }
  return queue;
}

/** Enqueues one raw webhook payload for async processing. Used by gateway/webhook.ts. */
export async function enqueueInboundWebhookPayload(env: Env, payload: unknown): Promise<void> {
  const q = getInboundQueue(env);
  await q.add('process', { payload, receivedAt: new Date().toISOString() });
}

export async function closeInboundQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
