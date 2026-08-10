/**
 * tools/broadcastTool.ts
 *
 * Broadcast Management tool (HLD Sec 6.1, 9). DB access only — the actual
 * "AI improves language", scheduling-decision, and audit-logging workflow
 * lives in `modules/broadcast.ts`, which is the only caller this tool is
 * meant to have (mirroring the tool/module split documented in
 * `docs/agent-orchestration.md`).
 *
 * `announcements.status` (`db/schema.ts`) has four states and this tool
 * drives all four transitions:
 *   draft -> pending_approval -> approved -> broadcast   (scheduled path)
 *   draft -> pending_approval -----------> broadcast     (immediate path)
 * `draftAnnouncement` inserts directly as `pending_approval` (the literal
 * `'draft'` status isn't used as a persisted intermediate step — a draft
 * only exists in the secretary's still-being-typed message until it's
 * submitted, at which point AI improvement has already run in
 * `modules/broadcast.ts` and the row is ready for the secretary to
 * approve).
 */
import { eq, sql } from 'drizzle-orm';
import { announcements } from '../db/schema.js';
import { getPostgresClient, type Database } from '../memory/postgresAdapter.js';
import type { ResidentsTool } from './residentsTool.js';
import type {
  WhatsAppTool,
  BroadcastAttachment,
  BroadcastResult as WhatsAppBroadcastResult,
} from './whatsappTool.js';

type AnnouncementRow = typeof announcements.$inferSelect;
export type AnnouncementStatus = AnnouncementRow['status'];

export interface DraftAnnouncementInput {
  /** Secretary's phone_e164 or display identity. */
  author: string;
  body: string;
  mediaUrls?: string[];
  scheduledFor?: Date;
}

export interface Announcement {
  id: string;
  status: AnnouncementStatus;
  body: string;
}

export interface AnnouncementDetail extends Announcement {
  author: string;
  mediaUrls: string[];
  scheduledAt: Date | null;
  approvedBy: string | null;
}

export interface ApproveAndSendResult {
  announcement: Announcement;
  broadcast: WhatsAppBroadcastResult;
  approvedBy: string;
}

/**
 * `announcements.media_urls` is a flat `text[]` (no structured attachment
 * columns) — `encodeAttachment`/`decodeAttachment` are the one agreed-upon
 * encoding so `modules/broadcast.ts` can round-trip a `BroadcastAttachment`
 * through that column: `"image:<mediaId>"` or `"document:<mediaId>:<filename>"`.
 */
export function encodeAttachment(attachment: BroadcastAttachment): string {
  return attachment.type === 'document'
    ? `document:${attachment.mediaId}:${attachment.filename ?? 'document.pdf'}`
    : `image:${attachment.mediaId}`;
}

export function decodeAttachment(encoded: string): BroadcastAttachment {
  const [type, mediaId, ...rest] = encoded.split(':');
  if (type === 'document') {
    return {
      type: 'document',
      mediaId: mediaId ?? '',
      ...(rest.length ? { filename: rest.join(':') } : {}),
    };
  }
  return { type: 'image', mediaId: mediaId ?? '' };
}

export interface BroadcastTool {
  draftAnnouncement(input: DraftAnnouncementInput): Promise<Announcement>;
  getAnnouncement(idPrefix: string): Promise<AnnouncementDetail | null>;
  /** Immediate path: `pending_approval` -> `broadcast`, sent right away. */
  approveAndSend(idPrefix: string, approvedBy: string): Promise<ApproveAndSendResult>;
  /** Scheduled path, step 1: `pending_approval` -> `approved`, not sent yet. */
  markApprovedForSchedule(idPrefix: string, approvedBy: string): Promise<Announcement>;
  /** Scheduled path, step 2 (run by the broadcast worker when the schedule fires): `approved` -> `broadcast`. */
  sendApprovedAnnouncement(id: string): Promise<ApproveAndSendResult>;
}

export interface BroadcastToolDeps {
  db?: Database;
  whatsapp: WhatsAppTool;
  /** Decrypted recipient phone numbers (HLD Sec 15 field-level encryption — see tools/residentsTool.ts). */
  residentsTool: Pick<ResidentsTool, 'listAllPhones'>;
}

export function createBroadcastTool(deps: BroadcastToolDeps): BroadcastTool {
  const db = deps.db ?? getPostgresClient();

  async function findByPrefix(idPrefix: string): Promise<AnnouncementRow | null> {
    const [row] = await db
      .select()
      .from(announcements)
      .where(sql`${announcements.id}::text like ${idPrefix + '%'}`)
      .limit(1);
    return row ?? null;
  }

  function toDetail(row: AnnouncementRow): AnnouncementDetail {
    return {
      id: row.id,
      status: row.status,
      body: row.body,
      author: row.author,
      mediaUrls: row.mediaUrls,
      scheduledAt: row.scheduledAt,
      approvedBy: row.approvedBy,
    };
  }

  /** Sends `row` now (recipients loaded fresh) and flips its status to `broadcast`. */
  async function sendAndFinalize(
    row: AnnouncementRow,
    approvedBy: string,
  ): Promise<ApproveAndSendResult> {
    const recipients = await deps.residentsTool.listAllPhones();
    const attachments = row.mediaUrls.map(decodeAttachment);
    const broadcast = await deps.whatsapp.broadcastMessage(recipients, {
      text: row.body,
      ...(attachments.length ? { attachments } : {}),
    });

    const [updated] = await db
      .update(announcements)
      .set({ status: 'broadcast', approvedBy, broadcastAt: new Date() })
      .where(eq(announcements.id, row.id))
      .returning();
    if (!updated) throw new Error('Failed to update announcement after broadcast.');

    return {
      announcement: { id: updated.id, status: updated.status, body: updated.body },
      broadcast,
      approvedBy,
    };
  }

  return {
    async draftAnnouncement(input) {
      const [row] = await db
        .insert(announcements)
        .values({
          author: input.author,
          body: input.body,
          mediaUrls: input.mediaUrls ?? [],
          status: 'pending_approval',
          ...(input.scheduledFor ? { scheduledAt: input.scheduledFor } : {}),
        })
        .returning();
      if (!row) throw new Error('Failed to draft announcement.');

      return { id: row.id, status: row.status, body: row.body };
    },

    async getAnnouncement(idPrefix) {
      const row = await findByPrefix(idPrefix);
      return row ? toDetail(row) : null;
    },

    async approveAndSend(idPrefix, approvedBy) {
      const existing = await findByPrefix(idPrefix);
      if (!existing) throw new Error(`No announcement found matching "${idPrefix}".`);
      if (existing.status !== 'pending_approval') {
        throw new Error(
          `Announcement ${idPrefix} is not pending approval (status: ${existing.status}).`,
        );
      }
      return sendAndFinalize(existing, approvedBy);
    },

    async markApprovedForSchedule(idPrefix, approvedBy) {
      const existing = await findByPrefix(idPrefix);
      if (!existing) throw new Error(`No announcement found matching "${idPrefix}".`);
      if (existing.status !== 'pending_approval') {
        throw new Error(
          `Announcement ${idPrefix} is not pending approval (status: ${existing.status}).`,
        );
      }

      const [updated] = await db
        .update(announcements)
        .set({ status: 'approved', approvedBy })
        .where(eq(announcements.id, existing.id))
        .returning();
      if (!updated) throw new Error('Failed to mark announcement approved.');

      return { id: updated.id, status: updated.status, body: updated.body };
    },

    async sendApprovedAnnouncement(id) {
      const [existing] = await db
        .select()
        .from(announcements)
        .where(eq(announcements.id, id))
        .limit(1);
      if (!existing) throw new Error(`No announcement found with id "${id}".`);
      if (existing.status !== 'approved') {
        throw new Error(`Announcement ${id} is not approved (status: ${existing.status}).`);
      }
      if (!existing.approvedBy) {
        throw new Error(`Announcement ${id} has no approvedBy recorded — cannot send.`);
      }
      return sendAndFinalize(existing, existing.approvedBy);
    },
  };
}
