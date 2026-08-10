/**
 * modules/escalation.ts
 *
 * Escalation Engine (HLD Sec 6.5): the single place every other subsystem's
 * "this needs a human" moment ends up —
 *
 *   - **guardrails (Phase 3.2)** — `agent/guardrails.ts`'s forbidden-action
 *     block and mandatory-escalation-trigger detection, enforced via
 *     `agent/escalation.ts`'s `checkMandatoryEscalation`/`escalateForReason`,
 *     which now call `escalate()` here instead of the tool directly.
 *   - **FAQ, low confidence** — `modules/faq.ts`'s confidence gate, via
 *     `agent/escalation.ts`'s `escalateUnknownAnswer` -> `escalate()` here.
 *   - **suggestions, rare** — a suggestion-shaped message that also matches
 *     a mandatory trigger (e.g. "the security guard keeps harassing me,
 *     please add cameras") is caught by `gateway/orchestrator.ts`'s
 *     mandatory-escalation check *before* `modules/suggestions.ts` ever
 *     runs — same consolidated path as guardrails above, not a separate
 *     code path, since the trigger check already runs unconditionally on
 *     every resident message ahead of intent-based routing.
 *   - **complaints** — no complaint flow escalates on its own today, but a
 *     resident's escalating message that also names a ticket
 *     (`"regarding TCK-2026-0001, I'll be consulting a lawyer"`) gets that
 *     ticket linked in the secretary notification automatically (see
 *     `linkedTicketId` below) — reusing `modules/complaints.ts`'s
 *     `extractTicketId` rather than requiring every caller to thread a
 *     ticket id through by hand.
 *
 * `tools/escalationTool.ts` still owns the DB write and the WhatsApp
 * notification (it needs the resident lookup, which is DB-tier); this
 * module owns *categorization*, the resident-facing reply text, and the
 * consolidated `escalate()` entry point every caller above goes through.
 */
import { ESCALATION_CATEGORIES } from '../config/constants.js';
import { extractTicketId } from './complaints.js';
import type { AuditLogWriter } from '../agent/guardrails.js';
import type {
  EscalationCategory,
  EscalationSourceType,
  EscalationStatus,
  EscalationTool,
  OpenEscalation,
} from '../tools/escalationTool.js';

export type { EscalationCategory, OpenEscalation };

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

/**
 * Maps the trigger/action *tokens* already embedded at the start of a
 * `reason` string by existing callers — `agent/escalation.ts`'s
 * `` `${trigger}: ${text}` `` (e.g. `"legal_issue: ..."`) and
 * `gateway/orchestrator.ts`'s `` `forbidden_action_request:${action}: ${text}` ``
 * — onto this module's five-category taxonomy. Deliberately not 1:1 with
 * `ESCALATION_TRIGGERS`/`AI_FORBIDDEN_ACTIONS` (config/constants.ts) — see
 * that file's `ESCALATION_CATEGORIES` doc comment for why.
 */
const TOKEN_CATEGORY_MAP: Record<string, EscalationCategory> = {
  legal_issue: 'legal_matter',
  police_complaint: 'abuse',
  harassment: 'abuse',
  financial_dispute: 'financial_dispute',
  unknown_answer: 'unknown_question',
  make_financial_decision: 'financial_dispute',
  approve_refund: 'financial_dispute',
  change_maintenance_amount: 'financial_dispute',
  change_resident_information: 'committee_decision',
  create_committee_decision: 'committee_decision',
  remove_complaint: 'committee_decision',
};

const KEYWORD_PATTERNS: ReadonlyArray<{ category: EscalationCategory; pattern: RegExp }> = [
  {
    category: 'legal_matter',
    pattern: /\b(lawyer|advocate|legal notice|court|litigation|\bsue\b|suing)\b/i,
  },
  {
    category: 'abuse',
    pattern:
      /\b(police|f\.?i\.?r\.?\b|harass(ed|ing|ment)?|threat(en(ed|ing)?)?|stalk(ed|ing)?|abusive|cognizable offen[cs]e)\b/i,
  },
  {
    category: 'financial_dispute',
    pattern:
      /\b(refund|financial dispute|payment dispute|maintenance (amount|charge)|\bfee(s)?\b|\bfund(s)?\b|budget)\b/i,
  },
];

/**
 * Categorizes a raw escalation `reason` into one of `ESCALATION_CATEGORIES`.
 * Checks a leading `token:` prefix first (the shape every existing caller's
 * `reason` string already has), then falls back to keyword matching over
 * the full text, then defaults to `'committee_decision'` — the safest
 * catch-all for "needs a human decision but doesn't fit a sharper bucket"
 * (e.g. a resident asking the AI to broadcast something).
 */
export function categorizeEscalation(reason: string): EscalationCategory {
  const forbiddenMatch = /^forbidden_action_request:([a-z_]+):/i.exec(reason);
  const leadingMatch = /^([a-z_]+):/i.exec(reason);
  const token = (forbiddenMatch?.[1] ?? leadingMatch?.[1])?.toLowerCase();
  if (token && token in TOKEN_CATEGORY_MAP) return TOKEN_CATEGORY_MAP[token]!;

  for (const { category, pattern } of KEYWORD_PATTERNS) {
    if (pattern.test(reason)) return category;
  }
  return 'committee_decision';
}

function isEscalationCategory(value: string): value is EscalationCategory {
  return (ESCALATION_CATEGORIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export interface EscalateInput {
  reason: string;
  sourceType: EscalationSourceType;
  sourceId: string;
  /** Auto-categorized from `reason` via `categorizeEscalation` if omitted. */
  category?: EscalationCategory;
  /** For the secretary notification's context — not required. */
  residentId?: string;
  /** The resident's original message text, included in the notification. */
  message?: string;
  /** Explicit related-ticket override; auto-detected from `message`/`reason` otherwise (see module doc comment). */
  ticketId?: string;
}

export interface EscalationOutcome {
  escalationId: string;
  category: EscalationCategory;
  /** Resident-facing reply — always says the message was forwarded, never implies the AI resolved it. */
  replyText: string;
}

export interface AcknowledgeOutcome {
  escalationId: string;
  status: EscalationStatus;
  replyText: string;
}

export interface OpenEscalationsOutcome {
  replyText: string;
  escalations: OpenEscalation[];
}

export interface EscalationModuleDeps {
  escalationTool: Pick<
    EscalationTool,
    'createEscalation' | 'acknowledgeEscalation' | 'listOpenEscalations'
  >;
  /** Writes the audit_logs row for every escalation created/acknowledged (HLD Sec 15). */
  auditLog: Pick<AuditLogWriter, 'logAction'>;
}

export interface EscalationModule {
  escalate(input: EscalateInput): Promise<EscalationOutcome>;
  /** `acknowledgedBy` — the secretary's phone_e164, for the audit_logs actor_id; omitted only for callers with no identity to attribute (e.g. tests). */
  acknowledge(
    idPrefix: string,
    status: 'acknowledged' | 'resolved',
    acknowledgedBy?: string,
  ): Promise<AcknowledgeOutcome>;
  listOpenEscalations(): Promise<OpenEscalationsOutcome>;
}

function referenceOf(escalationId: string): string {
  return escalationId.slice(0, 8);
}

function replyTextFor(escalationId: string, category: EscalationCategory): string {
  const ref = referenceOf(escalationId);
  if (category === 'unknown_question') {
    return `I couldn't find a confident answer to that in our records, so I've forwarded your question to the Secretary (ref: ${ref}).`;
  }
  return `This needs the Secretary's attention, so I've forwarded it to them directly (ref: ${ref}).`;
}

function formatOpenEscalation(escalation: OpenEscalation): string {
  const reasonPreview =
    escalation.reason.length > 80 ? `${escalation.reason.slice(0, 80)}…` : escalation.reason;
  return `• ${referenceOf(escalation.id)} [${escalation.category}] ${escalation.status} — ${reasonPreview}`;
}

export function createEscalationModule(deps: EscalationModuleDeps): EscalationModule {
  return {
    async escalate(input) {
      const category =
        input.category && isEscalationCategory(input.category)
          ? input.category
          : categorizeEscalation(input.reason);

      const linkedTicketId =
        input.ticketId ??
        extractTicketId(input.message ?? '') ??
        extractTicketId(input.reason) ??
        undefined;

      const escalation = await deps.escalationTool.createEscalation({
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        reason: input.reason,
        category,
        ...(input.residentId ? { residentId: input.residentId } : {}),
        ...(input.message ? { message: input.message } : {}),
        ...(linkedTicketId ? { ticketId: linkedTicketId } : {}),
      });

      await deps.auditLog.logAction({
        actorType: input.residentId ? 'resident' : 'ai',
        ...(input.residentId ? { actorId: input.residentId } : {}),
        action: 'escalation_created',
        entity: 'escalation',
        entityId: escalation.id,
        metadata: {
          category,
          sourceType: input.sourceType,
          ...(linkedTicketId ? { ticketId: linkedTicketId } : {}),
        },
      });

      return {
        escalationId: escalation.id,
        category,
        replyText: replyTextFor(escalation.id, category),
      };
    },

    async acknowledge(idPrefix, status, acknowledgedBy) {
      const escalation = await deps.escalationTool.acknowledgeEscalation(idPrefix, status);

      await deps.auditLog.logAction({
        actorType: 'secretary',
        ...(acknowledgedBy ? { actorId: acknowledgedBy } : {}),
        action: status === 'resolved' ? 'escalation_resolved' : 'escalation_acknowledged',
        entity: 'escalation',
        entityId: escalation.id,
        metadata: { status: escalation.status },
      });

      return {
        escalationId: escalation.id,
        status: escalation.status,
        replyText: `Escalation ${referenceOf(escalation.id)} marked ${escalation.status}.`,
      };
    },

    async listOpenEscalations() {
      const escalationsList = await deps.escalationTool.listOpenEscalations();
      if (escalationsList.length === 0) {
        return { replyText: 'No pending escalations.', escalations: escalationsList };
      }
      const lines = escalationsList.map(formatOpenEscalation);
      return {
        replyText: `${escalationsList.length} open escalation(s):\n${lines.join('\n')}`,
        escalations: escalationsList,
      };
    },
  };
}
