/**
 * gateway/inboundWorker.ts
 *
 * BullMQ worker that consumes the queue gateway/webhook.ts publishes to
 * (gateway/queue.ts) and runs gateway/inboundProcessor.ts on each job,
 * wired to the real OpenClaw Gateway (gateway/index.ts's
 * `createOpenClawGateway`) — session store, tool registry, memory, and
 * agent orchestration all live there so this worker and the HTTP process
 * (gateway/index.ts) share one construction path. This is the async half
 * of the <5s NFR split described in webhook.ts: the HTTP route only
 * enqueues, this process does the actual work.
 *
 * Run as its own process (`pnpm worker` / `pnpm build && node dist/gateway/inboundWorker.js`)
 * — separate from the HTTP server so the two can be scaled and restarted
 * independently, a standard split for a webhook-backed queue consumer.
 */
import { fileURLToPath } from 'node:url';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { loadEnv, loadEnvAsync, type Env } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { createResidentsTool } from '../tools/residentsTool.js';
import {
  createFieldEncryption,
  fieldEncryptionConfigFromEnv,
} from '../security/fieldEncryption.js';
import { INBOUND_WHATSAPP_QUEUE_NAME, type InboundWebhookJobData } from './queue.js';
import { processInboundWebhookPayload } from './inboundProcessor.js';
import { createOpenClawGateway } from './index.js';

const logger = createLogger('inboundWorker');

/** Creates (but does not start listening beyond BullMQ's own auto-run) the inbound worker. */
export function createInboundWorker(env: Env = loadEnv()): Worker<InboundWebhookJobData> {
  const connection: ConnectionOptions = { url: env.REDIS_URL } as ConnectionOptions;
  const gateway = createOpenClawGateway(env);
  // HLD Sec 15: residents.phone_e164 is field-level encrypted at rest, so
  // resolving "which resident just messaged us" (every single inbound
  // event) goes through tools/residentsTool.ts's blind-index lookup, not a
  // direct query.
  const residentsTool = createResidentsTool({
    fieldEncryption: createFieldEncryption(fieldEncryptionConfigFromEnv(env)),
  });

  async function handleJob(job: Job<InboundWebhookJobData>): Promise<void> {
    const result = await processInboundWebhookPayload(job.data.payload, {
      conversationStore: gateway.conversationStore,
      findResidentIdByPhone: (phoneE164) => residentsTool.findIdByPhone(phoneE164),
      logger,
      ...(env.WHATSAPP_SECRETARY_PHONE_NUMBER_ID
        ? { secretaryPhoneNumberId: env.WHATSAPP_SECRETARY_PHONE_NUMBER_ID }
        : {}),
      onEvent: (event, context) => gateway.orchestrator.handleResidentEvent(event, context),
      onSecretaryEvent: (event) => gateway.orchestrator.handleSecretaryEvent(event),
    });
    logger.info({ jobId: job.id, ...result }, 'Processed inbound WhatsApp webhook payload.');
  }

  const worker = new Worker<InboundWebhookJobData>(INBOUND_WHATSAPP_QUEUE_NAME, handleJob, {
    connection,
    concurrency: env.INBOUND_QUEUE_CONCURRENCY,
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Inbound WhatsApp webhook job failed.');
  });

  return worker;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // loadEnvAsync (HLD Sec 15), not the createInboundWorker default of
  // loadEnv() — this is the real process boot, where secrets must come
  // from GCP Secret Manager under SECRETS_SOURCE=gcp.
  const worker = createInboundWorker(await loadEnvAsync());
  logger.info('Inbound WhatsApp webhook worker started.');

  const shutdown = async () => {
    logger.info('Shutting down inbound WhatsApp webhook worker...');
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
