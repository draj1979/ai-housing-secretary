/**
 * gateway/broadcastWorker.ts
 *
 * BullMQ worker that consumes gateway/broadcastQueue.ts's delayed jobs and
 * runs `modules/broadcast.ts`'s `runScheduledBroadcast` — the send half of
 * a scheduled announcement (HLD Sec 6.1, 9): the secretary already
 * approved it (`approveAnnouncement` marked it `approved` and enqueued the
 * job), this worker just waits for the schedule to fire and then sends.
 *
 * Separate process from both the HTTP server (gateway/index.ts) and the
 * inbound-webhook worker (gateway/inboundWorker.ts) — same reasoning as
 * that split: a broadcast send shouldn't compete with, or be starved by,
 * inbound message processing. Run via `pnpm dev:broadcast-worker` (tsx
 * watch) or, in production, `pnpm broadcast-worker` after `pnpm build`.
 */
import { fileURLToPath } from 'node:url';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { loadEnv, loadEnvAsync, type Env } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { createOpenClawGateway } from './index.js';
import { BROADCAST_QUEUE_NAME, type ScheduledBroadcastJobData } from './broadcastQueue.js';

const logger = createLogger('broadcastWorker');

/** Creates (but does not start listening beyond BullMQ's own auto-run) the broadcast worker. */
export function createBroadcastWorker(env: Env = loadEnv()): Worker<ScheduledBroadcastJobData> {
  const connection: ConnectionOptions = { url: env.REDIS_URL } as ConnectionOptions;
  const gateway = createOpenClawGateway(env);

  async function handleJob(job: Job<ScheduledBroadcastJobData>): Promise<void> {
    const result = await gateway.broadcastModule.runScheduledBroadcast(job.data.announcementId);
    logger.info(
      {
        jobId: job.id,
        announcementId: result.announcement.id,
        recipientCount: result.recipientCount,
        failedCount: result.failedCount,
      },
      'Sent a scheduled broadcast.',
    );
  }

  // Concurrency 1: a scheduled broadcast's own fan-out (tools/whatsappTool.ts's
  // WHATSAPP_BROADCAST_CONCURRENCY) already parallelizes recipients; this
  // worker doesn't need to run multiple *announcements* at once, and
  // serializing them keeps audit_logs writes (and Cloud API rate-limit
  // pressure) from two broadcasts overlapping.
  const worker = new Worker<ScheduledBroadcastJobData>(BROADCAST_QUEUE_NAME, handleJob, {
    connection,
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Scheduled broadcast job failed.');
  });

  return worker;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // loadEnvAsync (HLD Sec 15) — see gateway/inboundWorker.ts's identical note.
  const worker = createBroadcastWorker(await loadEnvAsync());
  logger.info('Broadcast scheduling worker started.');

  const shutdown = async () => {
    logger.info('Shutting down broadcast scheduling worker...');
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
