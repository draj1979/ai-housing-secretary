/**
 * tools/escalationTool.ts
 *
 * Escalation Engine tool (HLD Sec 6.5, 16). Records an escalation and
 * notifies the human secretary over WhatsApp — the concrete mechanism
 * behind "AI must escalate" (agent/guardrails.ts detectEscalationTrigger,
 * modules/escalation.ts). The AI never resolves an escalation itself;
 * `acknowledgeEscalation` exists only for the *secretary's* side of the
 * conversation (gateway/orchestrator.ts's secretary-number command
 * handling) to mark one acknowledged/resolved, and `listOpenEscalations`
 * backs the "pending escalations" query the secretary can send.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { escalations } from '../db/schema.js';
import { getPostgresClient, type Database } from '../memory/postgresAdapter.js';
import type { WhatsAppTool } from './whatsappTool.js';
import type { ResidentsTool } from './residentsTool.js';

type EscalationRow = typeof escalations.$inferSelect;
export type EscalationSourceType = EscalationRow['sourceType'];
export type EscalationStatus = EscalationRow['status'];
export type EscalationCategory = EscalationRow['category'];

export interface CreateEscalationInput {
  sourceType: EscalationSourceType;
  /** id of the complaint/suggestion/conversation-session this escalation is about. */
  sourceId: string;
  reason: string;
  category: EscalationCategory;
  /** Resident this concerns, if any — looked up for the secretary notification's context (name, flat, phone); not persisted on the row itself (`sourceId`/`sourceType` already carry the durable link). */
  residentId?: string;
  /** The resident's original message, included in the notification verbatim. */
  message?: string;
  /** A related complaint's human-readable ticket id, if any — included in the notification. */
  ticketId?: string;
}

export interface Escalation {
  id: string;
  status: EscalationStatus;
  category: EscalationCategory;
}

export interface OpenEscalation {
  id: string;
  category: EscalationCategory;
  status: EscalationStatus;
  sourceType: EscalationSourceType;
  reason: string;
  createdAt: Date;
}

export interface EscalationTool {
  createEscalation(input: CreateEscalationInput): Promise<Escalation>;
  /** Secretary-side only — see module doc comment. */
  acknowledgeEscalation(idPrefix: string, status: 'acknowledged' | 'resolved'): Promise<Escalation>;
  /** `status IN ('pending', 'acknowledged')`, newest first — backs the "pending escalations" secretary query. */
  listOpenEscalations(): Promise<OpenEscalation[]>;
}

export interface EscalationToolDeps {
  db?: Database;
  whatsapp: WhatsAppTool;
  /** E.164 number to notify — config/env.ts WHATSAPP_SECRETARY_NUMBER. Omit to skip notification (e.g. in tests). */
  secretaryNumber?: string;
  /** Decrypts the resident's phone number for the notification (HLD Sec 15 field-level encryption — see tools/residentsTool.ts). Omit to skip the "Resident:" line entirely (e.g. in tests, or a composition path with no resident PII access). */
  residentsTool?: Pick<ResidentsTool, 'getContactById'>;
}

function buildNotificationText(
  row: Pick<EscalationRow, 'id' | 'sourceType' | 'category' | 'reason'>,
  input: Pick<CreateEscalationInput, 'message' | 'ticketId'>,
  resident: { name: string; flatNumber: string; phoneE164: string } | undefined,
): string {
  const lines = [`⚠️ Escalation [${row.category}] (${row.sourceType})`];
  if (resident) {
    lines.push(`Resident: ${resident.name}, Flat ${resident.flatNumber} (${resident.phoneE164})`);
  }
  if (input.ticketId) lines.push(`Related ticket: ${input.ticketId}`);
  if (input.message) lines.push(`Message: "${input.message}"`);
  lines.push(`Reason: ${row.reason}`);
  lines.push(`Ref: ${row.id.slice(0, 8)}`);
  return lines.join('\n');
}

export function createEscalationTool(deps: EscalationToolDeps): EscalationTool {
  const db = deps.db ?? getPostgresClient();

  return {
    async createEscalation(input) {
      const [row] = await db
        .insert(escalations)
        .values({
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          reason: input.reason,
          category: input.category,
        })
        .returning();
      if (!row) throw new Error('Failed to create escalation.');

      if (deps.secretaryNumber) {
        try {
          const contact =
            input.residentId && deps.residentsTool
              ? await deps.residentsTool.getContactById(input.residentId)
              : null;
          const resident = contact ?? undefined;

          await deps.whatsapp.sendMessage(
            deps.secretaryNumber,
            buildNotificationText(row, input, resident),
          );
          await db
            .update(escalations)
            .set({ notifiedSecretaryAt: new Date() })
            .where(eq(escalations.id, row.id));
        } catch {
          // The escalation is recorded regardless of whether the notification
          // send succeeded — losing the DB record because WhatsApp was
          // briefly unreachable would be worse than a missed notification.
        }
      }

      return { id: row.id, status: row.status, category: row.category };
    },

    async acknowledgeEscalation(idPrefix, status) {
      const [existing] = await db
        .select({ id: escalations.id })
        .from(escalations)
        .where(sql`${escalations.id}::text like ${idPrefix + '%'}`)
        .limit(1);
      if (!existing) throw new Error(`No escalation found matching "${idPrefix}".`);

      const [updated] = await db
        .update(escalations)
        .set({ status })
        .where(eq(escalations.id, existing.id))
        .returning();
      if (!updated) throw new Error('Failed to update escalation.');

      return { id: updated.id, status: updated.status, category: updated.category };
    },

    async listOpenEscalations() {
      const rows = await db
        .select()
        .from(escalations)
        .where(inArray(escalations.status, ['pending', 'acknowledged']))
        .orderBy(desc(escalations.createdAt));

      return rows.map((row) => ({
        id: row.id,
        category: row.category,
        status: row.status,
        sourceType: row.sourceType,
        reason: row.reason,
        createdAt: row.createdAt,
      }));
    },
  };
}
