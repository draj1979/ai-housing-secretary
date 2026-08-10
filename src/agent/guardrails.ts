/**
 * agent/guardrails.ts
 *
 * AI Safety Guardrails enforcement layer (HLD Sec 16) — enforced in code,
 * not just prompted (agent/systemPrompt.ts is defense in depth, not the
 * primary mechanism):
 *
 *   - `assertNotForbidden` — a synchronous guard any tool implementing one
 *     of the AI_FORBIDDEN_ACTIONS must call before doing anything else.
 *     Throws, does not just warn.
 *   - `detectForbiddenActionRequest` — scans a resident's *message* for
 *     phrasing that's asking the AI to perform a forbidden action (approve
 *     a refund, change the maintenance amount, delete a complaint, ...).
 *   - `enforceForbiddenActionGuardrail` — the orchestrator's actual call
 *     site: detects + writes an `audit_logs` row recording the block
 *     *before* returning control, so a blocked attempt is never silent.
 *   - `detectEscalationTrigger` — mandatory-escalation text patterns (HLD
 *     Sec 16); see agent/escalation.ts for how these are enforced.
 */
import { AI_FORBIDDEN_ACTIONS, ESCALATION_TRIGGERS } from '../config/constants.js';
import { auditLogs } from '../db/schema.js';
import { getPostgresClient, type Database } from '../memory/postgresAdapter.js';
import type { ResidentsTool } from '../tools/residentsTool.js';

export type ForbiddenAction = (typeof AI_FORBIDDEN_ACTIONS)[number];
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

export class ForbiddenActionError extends Error {
  constructor(public readonly action: string) {
    super(
      `Action "${action}" is forbidden for the AI Secretary (HLD Sec 16) — it requires the human secretary.`,
    );
    this.name = 'ForbiddenActionError';
  }
}

/**
 * Throws `ForbiddenActionError` if `action` is one of `AI_FORBIDDEN_ACTIONS`
 * (HLD Sec 16: financial decisions, refunds, changing maintenance amounts,
 * changing resident info, committee decisions, removing complaints);
 * no-ops otherwise. Takes a plain `string` (not `ForbiddenAction`) so it can
 * guard an arbitrary action id derived at runtime, not just a value already
 * known to be forbidden. This is the guard any *tool* that implements one
 * of these actions must call first — today no such tool exists (they're
 * intentionally never implemented; only the human secretary can do them),
 * so this exists as a structural trip-wire against ever adding one that
 * skips the check.
 */
export function assertNotForbidden(action: string): void {
  if ((AI_FORBIDDEN_ACTIONS as readonly string[]).includes(action)) {
    throw new ForbiddenActionError(action);
  }
}

// ---------------------------------------------------------------------------
// Forbidden-action *requests* — a resident asking the AI to do one of these
// ---------------------------------------------------------------------------

// Deliberately phrased as requests directed at the AI ("please reduce my
// maintenance", "can you delete this complaint"), not just any mention of
// the topic — a resident describing a high maintenance bill in a complaint
// isn't asking the AI to change it.
const FORBIDDEN_ACTION_PATTERNS: Record<ForbiddenAction, RegExp> = {
  make_financial_decision:
    /\b(approve (the )?budget|make a financial decision|sanction (the )?expense|authoriz(e|ation) (the )?(payment|expense))\b/i,
  approve_refund: /\b(refund|reimburse(ment)?|money back|return my money)\b/i,
  change_maintenance_amount:
    /\b(change|reduce|increase|waive|lower|adjust)\b.{0,25}\bmaintenance\b.{0,15}\b(charge|amount|fee)?\b|\bmaintenance\b.{0,15}\b(charge|amount|fee)\b.{0,25}\b(change|reduce|increase|waive|lower|adjust)\b/i,
  change_resident_information:
    /\b(update|change|correct)\b.{0,20}\bmy\b.{0,20}\b(phone|number|flat|details|information|name|email)\b/i,
  create_committee_decision:
    /\b(committee decision|pass a resolution|committee should decide|make (this|it) a committee (matter|decision))\b/i,
  remove_complaint: /\b(delete|remove|cancel|withdraw)\b.{0,15}(my )?(complaint|ticket)\b/i,
};

/**
 * Scans free text for a request to perform one of `AI_FORBIDDEN_ACTIONS`.
 * Checked *first* in gateway/orchestrator.ts — before intent detection,
 * before knowledge search, before Gemini — because the requirement here is
 * "blocked", not "the AI happens not to have a tool for this". Returns the
 * first matching action, or `null`.
 */
export function detectForbiddenActionRequest(message: string): ForbiddenAction | null {
  for (const action of Object.keys(FORBIDDEN_ACTION_PATTERNS) as ForbiddenAction[]) {
    if (FORBIDDEN_ACTION_PATTERNS[action]!.test(message)) return action;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audit logging for blocked attempts (HLD Sec 15, referenced by Sec 16:
// "Any tool call matching these must be rejected before execution and
// logged to audit_logs")
// ---------------------------------------------------------------------------

export interface ForbiddenActionAuditInput {
  action: ForbiddenAction;
  text: string;
  /** Resident's E.164 phone, if known — recorded as actor_id. */
  actorPhoneE164?: string;
  sourceId?: string;
}

/** modules/broadcast.ts's record of who approved a broadcast, and how many residents it reached (HLD Sec 6.1, 15). */
export interface BroadcastAuditInput {
  /** Secretary's phone_e164 who approved it — recorded as actor_id ("who"). */
  approvedBy: string;
  announcementId: string;
  recipientCount: number;
  failedCount: number;
}

/**
 * Generic audit row (HLD Sec 15: "audit_logs captures every tool call that
 * touches resident data or triggers a broadcast/escalation, including
 * actor, action, and timestamp") for the write paths that don't have their
 * own dedicated method above — complaint filing, suggestion filing,
 * escalation creation/acknowledgement (modules/complaints.ts,
 * modules/suggestions.ts, modules/escalation.ts). `logForbiddenActionBlocked`
 * and `logBroadcastSent` stay as dedicated methods (richer, differently-shaped
 * metadata each caller already builds precisely); this is the catch-all for
 * everything else that must not go unaudited.
 */
export interface AuditActionInput {
  actorType: 'resident' | 'ai' | 'secretary' | 'system';
  /** Resident id, secretary phone_e164, or omitted for a system/ai actor with no specific identity. */
  actorId?: string;
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogWriter {
  logForbiddenActionBlocked(input: ForbiddenActionAuditInput): Promise<void>;
  logBroadcastSent(input: BroadcastAuditInput): Promise<void>;
  logAction(input: AuditActionInput): Promise<void>;
}

export interface AuditLogWriterDeps {
  db?: Database;
  /**
   * Resolves a resident id from their phone number (HLD Sec 15's
   * field-level encryption means `residents.phone_e164` can't be queried
   * directly — see tools/residentsTool.ts). Optional: a composition path
   * with no resident-facing forbidden-action blocking to audit (e.g.
   * gateway/index.ts's admin-routes-only build) can omit it; `actor_id`
   * just stays unset for that one lookup rather than the whole write failing.
   */
  residentsTool?: Pick<ResidentsTool, 'findIdByPhone'>;
}

/**
 * Writes to `audit_logs` (HLD Sec 15). Looks up the resident's id from
 * their phone (if given and `residentsTool` is provided) so `actor_id` is
 * a stable resident id rather than a raw phone number sitting in an audit
 * trail.
 */
export function createAuditLogWriter(deps: AuditLogWriterDeps = {}): AuditLogWriter {
  const db = deps.db ?? getPostgresClient();

  return {
    async logForbiddenActionBlocked(input) {
      const actorId =
        input.actorPhoneE164 && deps.residentsTool
          ? await deps.residentsTool.findIdByPhone(input.actorPhoneE164)
          : undefined;

      await db.insert(auditLogs).values({
        actorType: 'ai',
        ...(actorId ? { actorId } : {}),
        action: 'blocked_forbidden_action',
        entity: 'forbidden_action',
        entityId: input.action,
        metadata: {
          requestedAction: input.action,
          text: input.text,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        },
      });
    },

    // "When" is `audit_logs.created_at` (defaultNow()); "who" is actor_id;
    // "recipient count" is metadata.recipientCount — the three things HLD
    // Sec 6.1's "log every broadcast" asks for, all on one row.
    async logBroadcastSent(input) {
      await db.insert(auditLogs).values({
        actorType: 'secretary',
        actorId: input.approvedBy,
        action: 'broadcast_sent',
        entity: 'announcement',
        entityId: input.announcementId,
        metadata: {
          approvedBy: input.approvedBy,
          recipientCount: input.recipientCount,
          failedCount: input.failedCount,
        },
      });
    },

    async logAction(input) {
      await db.insert(auditLogs).values({
        actorType: input.actorType,
        ...(input.actorId ? { actorId: input.actorId } : {}),
        action: input.action,
        entity: input.entity,
        ...(input.entityId ? { entityId: input.entityId } : {}),
        metadata: input.metadata ?? {},
      });
    },
  };
}

/**
 * The orchestrator's actual enforcement call site: detects a forbidden-
 * action request and, if found, writes the audit_logs row *before*
 * returning — so a blocked attempt is always on record, not just refused
 * in the reply text. Returns the blocked action, or `null` if the message
 * didn't request one.
 */
export async function enforceForbiddenActionGuardrail(
  text: string,
  auditLog: Pick<AuditLogWriter, 'logForbiddenActionBlocked'>,
  context?: { actorPhoneE164?: string; sourceId?: string },
): Promise<ForbiddenAction | null> {
  const action = detectForbiddenActionRequest(text);
  if (!action) return null;

  await auditLog.logForbiddenActionBlocked({
    action,
    text,
    ...(context?.actorPhoneE164 ? { actorPhoneE164: context.actorPhoneE164 } : {}),
    ...(context?.sourceId ? { sourceId: context.sourceId } : {}),
  });

  return action;
}

// ---------------------------------------------------------------------------
// Mandatory escalation triggers — see agent/escalation.ts for enforcement
// ---------------------------------------------------------------------------

// Deliberately excludes `unknown_answer` — that's not a text pattern, it's
// set directly by agent/escalation.ts when knowledge search / Gemini can't
// produce a confident answer (config/constants.ts FAQ_MIN_CONFIDENCE_SCORE).
const ESCALATION_PATTERNS: Record<Exclude<EscalationTrigger, 'unknown_answer'>, RegExp> = {
  legal_issue: /\b(lawyer|advocate|legal notice|court|litigation|\bsue\b|suing)\b/i,
  police_complaint: /\b(police|f\.?i\.?r\.?\b|filed a complaint|cognizable offen[cs]e)\b/i,
  harassment: /\b(harass(ed|ing|ment)?|threat(en(ed|ing)?)?|stalk(ed|ing)?|abusive)\b/i,
  financial_dispute:
    /\b(refund|overcharg(e|ed|ing)?|\bfraud\b|embezzl(e|ed|ing|ement)?|misappropriat(e|ed|ing|ion)?|money (missing|stolen))\b/i,
};

/**
 * Scans free text for phrasing that must be escalated to the human
 * secretary rather than answered by the AI (HLD Sec 16). Checked *before*
 * intent detection in gateway/orchestrator.ts — a guardrail match always
 * overrides whatever agent/intentRouter.ts would have classified the
 * message as. Returns the first matching trigger, or `null`.
 */
export function detectEscalationTrigger(message: string): EscalationTrigger | null {
  for (const trigger of Object.keys(ESCALATION_PATTERNS) as Array<
    keyof typeof ESCALATION_PATTERNS
  >) {
    if (ESCALATION_PATTERNS[trigger].test(message)) return trigger;
  }
  return null;
}
