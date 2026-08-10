/**
 * gateway/broadcastQueue.ts
 *
 * BullMQ queue backing `modules/broadcast.ts`'s `BroadcastScheduler` seam —
 * the "queued job" a scheduled announcement's send is deferred to (HLD Sec
 * 6.1, 9). Mirrors gateway/queue.ts's inbound-webhook queue/worker split:
 * `createBroadcastScheduler` (producer, used by gateway/index.ts to wire
 * `modules/broadcast.ts`) enqueues a *delayed* job for `runAt`;
 * gateway/broadcastWorker.ts (consumer, its own process) runs it by calling
 * back into `BroadcastModule.runScheduledBroadcast`.
 */
import { Queue, type ConnectionOptions } from 'bullmq';
import type { Env } from '../config/env.js';
import type { BroadcastScheduler } from '../modules/broadcast.js';

export const BROADCAST_QUEUE_NAME = 'broadcast-scheduled';

export interface ScheduledBroadcastJobData {
  announcementId: string;
}

let queue: Queue<ScheduledBroadcastJobData> | undefined;

function connectionFromEnv(env: Env): ConnectionOptions {
  return { url: env.REDIS_URL } as ConnectionOptions;
}

/** Lazily-created, process-wide BullMQ Queue producer. */
export function getBroadcastQueue(env: Env): Queue<ScheduledBroadcastJobData> {
  if (!queue) {
    queue = new Queue<ScheduledBroadcastJobData>(BROADCAST_QUEUE_NAME, {
      connection: connectionFromEnv(env),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 1000 },
      },
    });
  }
  return queue;
}

/** BullMQ-backed `BroadcastScheduler` — enqueues a job delayed until `runAt`. */
export function createBroadcastScheduler(env: Env): BroadcastScheduler {
  return {
    async scheduleBroadcast(announcementId, runAt) {
      const q = getBroadcastQueue(env);
      const delay = Math.max(0, runAt.getTime() - Date.now());
      await q.add(
        'send',
        { announcementId },
        // A stable jobId means re-approving the same announcement (e.g. a
        // retried secretary message) replaces the pending job instead of
        // double-scheduling it.
        { delay, jobId: announcementId },
      );
    },
  };
}

export async function closeBroadcastQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
