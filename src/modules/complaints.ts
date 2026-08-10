/**
 * modules/complaints.ts
 *
 * Complaint Management (HLD Sec 6.3, workflow in Sec 11):
 *
 *   Resident -> Complaint -> AI -> Database -> Ticket Created ->
 *   Secretary Notified -> Resident Gets Ticket
 *
 * Two flows:
 *   - `fileComplaint` — a new complaint: create the row (ticket id
 *     generation lives in tools/complaintTool.ts), notify the secretary
 *     over WhatsApp with the details + ticket id, and return the
 *     resident-facing confirmation reply.
 *   - Status check — a message that references an existing ticket id (e.g.
 *     "status of TCK-2026-0001") looks it up instead of filing a new one.
 *
 * `handleMessage` is the single entry point gateway/orchestrator.ts calls
 * for its `complaint` intent branch — it decides which of the two flows a
 * message is, so the orchestrator doesn't need to.
 */
import type { Complaint, ComplaintStatus, ComplaintTool } from '../tools/complaintTool.js';
import type { WhatsAppTool } from '../tools/whatsappTool.js';
import type { AuditLogWriter } from '../agent/guardrails.js';

const TICKET_ID_PATTERN = /\bTCK-\d{4}-\d{4}\b/i;

/**
 * Pulls a ticket id reference out of free text (e.g. "status of
 * TCK-2026-0001", "any update on tck-2026-0001?", or just the ticket id on
 * its own) and normalizes it to the stored uppercase form. `null` if the
 * text doesn't mention one — the caller then treats the message as a new
 * complaint rather than a status check. Pure — see complaints.test.ts.
 */
export function extractTicketId(text: string): string | null {
  const match = TICKET_ID_PATTERN.exec(text);
  return match ? match[0].toUpperCase() : null;
}

function formatStatusReply(status: ComplaintStatus): string {
  const statusLabel = status.status.replace(/_/g, ' ');
  const resolvedNote =
    status.status === 'resolved' && status.resolvedAt
      ? ` (resolved ${status.resolvedAt.toDateString()})`
      : '';
  return `Ticket ${status.ticketId} is currently *${statusLabel}*${resolvedNote}. Filed: ${status.createdAt.toDateString()}.`;
}

export interface FileComplaintInput {
  residentId: string;
  description: string;
  category?: string;
}

export interface ComplaintOutcome {
  replyText: string;
  kind: 'filed' | 'status_found' | 'status_not_found';
  complaint?: Complaint;
  status?: ComplaintStatus;
}

export interface ComplaintModuleDeps {
  complaintTool: Pick<ComplaintTool, 'createComplaint' | 'getComplaintByTicketId'>;
  whatsapp: Pick<WhatsAppTool, 'sendMessage'>;
  /** E.164 number to notify on a new complaint — config/env.ts WHATSAPP_SECRETARY_NUMBER. Omit to skip notification (e.g. in tests). */
  secretaryNumber?: string;
  /** Writes the audit_logs row for a filed complaint (HLD Sec 15 — "every tool call that touches resident data"). */
  auditLog: Pick<AuditLogWriter, 'logAction'>;
}

export interface ComplaintModule {
  /**
   * Files a new complaint: creates the row (and its ticket id), notifies
   * the secretary, and returns the resident-facing confirmation.
   */
  fileComplaint(input: FileComplaintInput): Promise<ComplaintOutcome>;
  /**
   * Looks up a ticket by id, scoped to the requesting resident — HLD Sec
   * 6.3's status-check flow ("status of TCK-2026-0001"). Deliberately
   * returns `status_not_found` (rather than the row) for a ticket that
   * exists but belongs to a different resident, so one resident can't
   * enumerate another's complaint status by guessing sequential ticket ids.
   */
  checkStatus(ticketId: string, residentId: string): Promise<ComplaintOutcome>;
  /**
   * Dispatches a resident message to `checkStatus` (if it references a
   * ticket id) or `fileComplaint` (otherwise) — the one call
   * gateway/orchestrator.ts's `complaint` intent branch needs.
   */
  handleMessage(
    text: string,
    input: Omit<FileComplaintInput, 'description'>,
  ): Promise<ComplaintOutcome>;
}

export function createComplaintModule(deps: ComplaintModuleDeps): ComplaintModule {
  async function fileComplaint(input: FileComplaintInput): Promise<ComplaintOutcome> {
    const complaint = await deps.complaintTool.createComplaint({
      residentId: input.residentId,
      description: input.description,
      ...(input.category ? { category: input.category } : {}),
    });

    if (deps.secretaryNumber) {
      try {
        await deps.whatsapp.sendMessage(
          deps.secretaryNumber,
          `🔧 New complaint — Flat ${complaint.flatNumber}\nTicket: ${complaint.ticketId}\n${input.description}`,
        );
      } catch {
        // The complaint is recorded regardless of whether the notification
        // send succeeded — losing the DB record because WhatsApp was
        // briefly unreachable would be worse than a missed notification
        // (same tradeoff as tools/escalationTool.ts's createEscalation).
      }
    }

    await deps.auditLog.logAction({
      actorType: 'resident',
      actorId: input.residentId,
      action: 'complaint_created',
      entity: 'complaint',
      entityId: complaint.id,
      metadata: { ticketId: complaint.ticketId, flatNumber: complaint.flatNumber },
    });

    return {
      kind: 'filed',
      complaint,
      replyText: `Thanks — I've logged this as ticket ${complaint.ticketId}. The Secretary/Facility team will follow up. You can check progress anytime by asking "status of ${complaint.ticketId}".`,
    };
  }

  async function checkStatus(ticketId: string, residentId: string): Promise<ComplaintOutcome> {
    const status = await deps.complaintTool.getComplaintByTicketId(ticketId);

    if (!status || status.residentId !== residentId) {
      return {
        kind: 'status_not_found',
        replyText: `I couldn't find a ticket ${ticketId} on your account. Please double-check the ticket id.`,
      };
    }

    return { kind: 'status_found', status, replyText: formatStatusReply(status) };
  }

  return {
    fileComplaint,
    checkStatus,
    async handleMessage(text, input) {
      const ticketId = extractTicketId(text);
      if (ticketId) {
        return checkStatus(ticketId, input.residentId);
      }
      return fileComplaint({ ...input, description: text });
    },
  };
}
