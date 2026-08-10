/**
 * modules/broadcast.ts
 *
 * Broadcast Management (HLD Sec 6.1, workflow Sec 9):
 *
 *   Secretary drafts -> AI improves language/formatting -> Secretary
 *   approves -> Broadcast goes out to residents
 *
 * The AI never sends anything itself — `draftAnnouncement` only ever
 * produces a *preview* for the secretary; `approveAnnouncement` is the one
 * path that can result in a send, and it always requires an explicit
 * approval call from `gateway/orchestrator.ts`'s secretary-command
 * handling (HLD Sec 16: broadcasting is not an AI decision).
 *
 * Scheduling (`scheduled_at`): if the secretary approves a draft whose
 * `scheduledFor` is still in the future, this module does *not* send —
 * it marks the announcement `approved` and hands the send off to a BullMQ
 * delayed job (`deps.scheduler`, backed by gateway/broadcastQueue.ts) that
 * calls `runScheduledBroadcast` when the schedule fires. Approving a draft
 * with no `scheduledFor`, or one whose schedule has already passed, sends
 * immediately — same as the pre-scheduling behavior.
 *
 * The <30s broadcast NFR (HLD Sec 17) is enforced by
 * `tools/whatsappTool.ts`'s `broadcastMessage`, which fans out to all
 * recipients with at most `WHATSAPP_BROADCAST_CONCURRENCY` in flight at
 * once rather than sequentially — this module and `tools/broadcastTool.ts`
 * just call it, the concurrency bound is what keeps a ~1000-resident
 * broadcast (`NFR_TARGETS.minResidentCapacity`) under 30s.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Env } from '../config/env.js';
import type { BroadcastAuditInput, AuditLogWriter } from '../agent/guardrails.js';
import { encodeAttachment, type Announcement, type BroadcastTool } from '../tools/broadcastTool.js';
import type { BroadcastAttachment, UploadMediaInput, WhatsAppTool } from '../tools/whatsappTool.js';

// ---------------------------------------------------------------------------
// "AI Improves Language" (HLD Sec 9)
// ---------------------------------------------------------------------------

export interface LanguageImprover {
  improve(rawText: string): Promise<string>;
}

export interface LanguageImproverConfig {
  apiKey: string;
  model: string;
  /** Injectable for tests — bypasses the real Gemini client entirely. */
  improveImpl?: (rawText: string) => Promise<string>;
}

/** Builds a LanguageImproverConfig from env — the one place this module reads env. */
export function languageImproverConfigFromEnv(env: Env): LanguageImproverConfig {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required to improve announcement language.');
  }
  return { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL };
}

const IMPROVE_PROMPT = `You are formatting a housing society announcement for a WhatsApp broadcast.

Rules:
- Keep the same meaning and every factual detail unchanged (dates, times, amounts, names, locations).
- Fix grammar, punctuation, and structure; use short paragraphs or a bullet list where it helps.
- Do not add information that wasn't in the original text.
- Return only the improved announcement text, nothing else (no preamble, no quotes).

Original announcement:
`;

async function improveWithGemini(config: LanguageImproverConfig, rawText: string): Promise<string> {
  const client = new GoogleGenerativeAI(config.apiKey);
  const model = client.getGenerativeModel({ model: config.model });
  const result = await model.generateContent(IMPROVE_PROMPT + rawText);
  return result.response.text();
}

/**
 * Improves an announcement's formatting/language via Gemini. Never returns
 * an empty string — a blank/whitespace-only model response falls back to
 * the original text rather than shipping a preview with nothing in it.
 */
export function createLanguageImprover(config: LanguageImproverConfig): LanguageImprover {
  return {
    async improve(rawText) {
      const raw = config.improveImpl
        ? await config.improveImpl(rawText)
        : await improveWithGemini(config, rawText);
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : rawText;
    },
  };
}

// ---------------------------------------------------------------------------
// Scheduling — delayed send when `scheduledFor` is in the future
// ---------------------------------------------------------------------------

/**
 * Minimal seam over the real queue (gateway/broadcastQueue.ts, BullMQ) so
 * this module stays unit-testable without Redis. `runAt` in the past is
 * valid — the scheduler backend is expected to run it immediately.
 */
export interface BroadcastScheduler {
  scheduleBroadcast(announcementId: string, runAt: Date): Promise<void>;
}

// ---------------------------------------------------------------------------
// The module: draft -> improve -> preview, and approve -> send-or-schedule
// ---------------------------------------------------------------------------

export interface DraftAnnouncementInput {
  /** Secretary's phone_e164. */
  author: string;
  body: string;
  scheduledFor?: Date;
  /** New media to upload from a file/buffer (see `tools/whatsappTool.ts`'s `UploadMediaInput`). */
  imageAttachments?: UploadMediaInput[];
  pdfAttachments?: UploadMediaInput[];
  /** Already-uploaded media (e.g. a WhatsApp media id reused from an inbound secretary message) — skips uploading. */
  existingAttachments?: BroadcastAttachment[];
}

export interface DraftOutcome {
  replyText: string;
  announcement: Announcement;
  /** `false` if Gemini failed and the original wording was used as-is. */
  improvedByGemini: boolean;
}

export interface ApproveAnnouncementInput {
  idPrefix: string;
  approvedBy: string;
}

export interface ApproveOutcome {
  replyText: string;
  kind: 'sent' | 'scheduled';
  announcement: Announcement;
  recipientCount?: number;
  failedCount?: number;
}

export interface RunScheduledBroadcastOutcome {
  announcement: Announcement;
  recipientCount: number;
  failedCount: number;
}

export interface BroadcastModuleDeps {
  languageImprover: Pick<LanguageImprover, 'improve'>;
  broadcastTool: Pick<
    BroadcastTool,
    | 'draftAnnouncement'
    | 'getAnnouncement'
    | 'approveAndSend'
    | 'markApprovedForSchedule'
    | 'sendApprovedAnnouncement'
  >;
  whatsapp: Pick<WhatsAppTool, 'uploadImage' | 'uploadPDF'>;
  auditLog: Pick<AuditLogWriter, 'logBroadcastSent'>;
  scheduler: Pick<BroadcastScheduler, 'scheduleBroadcast'>;
}

export interface BroadcastModule {
  draftAnnouncement(input: DraftAnnouncementInput): Promise<DraftOutcome>;
  approveAnnouncement(input: ApproveAnnouncementInput): Promise<ApproveOutcome>;
  /** Called by gateway/broadcastWorker.ts when a scheduled announcement's delayed job fires. */
  runScheduledBroadcast(announcementId: string): Promise<RunScheduledBroadcastOutcome>;
}

async function logSent(
  auditLog: BroadcastModuleDeps['auditLog'],
  input: BroadcastAuditInput,
): Promise<void> {
  await auditLog.logBroadcastSent(input);
}

export function createBroadcastModule(deps: BroadcastModuleDeps): BroadcastModule {
  return {
    async draftAnnouncement(input) {
      let improvedBody = input.body;
      let improvedByGemini = true;
      try {
        improvedBody = await deps.languageImprover.improve(input.body);
      } catch {
        improvedBody = input.body;
        improvedByGemini = false;
      }

      const attachments: BroadcastAttachment[] = [...(input.existingAttachments ?? [])];
      for (const upload of input.imageAttachments ?? []) {
        const { mediaId } = await deps.whatsapp.uploadImage(upload);
        attachments.push({ type: 'image', mediaId });
      }
      for (const upload of input.pdfAttachments ?? []) {
        const { mediaId } = await deps.whatsapp.uploadPDF(upload);
        attachments.push({
          type: 'document',
          mediaId,
          ...(upload.filename ? { filename: upload.filename } : {}),
        });
      }

      const announcement = await deps.broadcastTool.draftAnnouncement({
        author: input.author,
        body: improvedBody,
        mediaUrls: attachments.map(encodeAttachment),
        ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
      });

      const ref = announcement.id.slice(0, 8);
      const scheduleNote = input.scheduledFor
        ? ` It's scheduled to go out at ${input.scheduledFor.toISOString()} once approved.`
        : '';

      return {
        announcement,
        improvedByGemini,
        replyText:
          `Here's the AI-formatted preview:\n\n${announcement.body}\n\n` +
          `Reply "approve ${ref}" to broadcast it to all residents.${scheduleNote}`,
      };
    },

    async approveAnnouncement({ idPrefix, approvedBy }) {
      const existing = await deps.broadcastTool.getAnnouncement(idPrefix);
      if (!existing) throw new Error(`No announcement found matching "${idPrefix}".`);
      if (existing.status !== 'pending_approval') {
        throw new Error(
          `Announcement ${idPrefix} is not pending approval (status: ${existing.status}).`,
        );
      }

      if (existing.scheduledAt && existing.scheduledAt.getTime() > Date.now()) {
        const announcement = await deps.broadcastTool.markApprovedForSchedule(idPrefix, approvedBy);
        await deps.scheduler.scheduleBroadcast(announcement.id, existing.scheduledAt);
        return {
          kind: 'scheduled',
          announcement,
          replyText: `Approved. It'll broadcast automatically at ${existing.scheduledAt.toISOString()}.`,
        };
      }

      const { announcement, broadcast } = await deps.broadcastTool.approveAndSend(
        idPrefix,
        approvedBy,
      );
      await logSent(deps.auditLog, {
        approvedBy,
        announcementId: announcement.id,
        recipientCount: broadcast.sent.length,
        failedCount: broadcast.failed.length,
      });

      return {
        kind: 'sent',
        announcement,
        recipientCount: broadcast.sent.length,
        failedCount: broadcast.failed.length,
        replyText: `Broadcast sent to ${broadcast.sent.length} resident(s) (${broadcast.failed.length} failed) in ${broadcast.durationMs}ms.`,
      };
    },

    async runScheduledBroadcast(announcementId) {
      const { announcement, broadcast, approvedBy } =
        await deps.broadcastTool.sendApprovedAnnouncement(announcementId);
      await logSent(deps.auditLog, {
        approvedBy,
        announcementId: announcement.id,
        recipientCount: broadcast.sent.length,
        failedCount: broadcast.failed.length,
      });

      return {
        announcement,
        recipientCount: broadcast.sent.length,
        failedCount: broadcast.failed.length,
      };
    },
  };
}
