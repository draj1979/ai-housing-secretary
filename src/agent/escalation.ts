/**
 * agent/escalation.ts
 *
 * Mandatory escalation policy (HLD Sec 16): legal issues, police
 * complaints, harassment, financial disputes, and "unknown answer" (no
 * confident knowledge-base match) must *always* create an escalation
 * record and notify the human secretary — the AI must never attempt to
 * answer these itself. This module is gateway/orchestrator.ts's single
 * call site for that rule, so there is exactly one place a mandatory
 * trigger can be enforced (and exactly one place to check if you're
 * auditing that it's never bypassed) rather than the check being inlined
 * ad hoc wherever a reply is generated.
 *
 * Building block only: *detection* (this file, `detectEscalationTrigger`
 * from agent/guardrails.ts) is kept separate from *creation and
 * notification*, which is `modules/escalation.ts`'s job (HLD Sec 6.5) —
 * every function below just supplies the trigger/reason and delegates the
 * actual escalate() call to it. See modules/escalation.ts's doc comment
 * for the full list of subsystems this consolidates.
 */
import { detectEscalationTrigger, type EscalationTrigger } from './guardrails.js';
import type { EscalationModule } from '../modules/escalation.js';
import type { EscalationSourceType } from '../tools/escalationTool.js';

export interface EscalationContext {
  sourceType: EscalationSourceType;
  sourceId: string;
  /** For the secretary notification's context (HLD Sec 6.5: "full context") — omit when unknown (e.g. the secretary's own path). */
  residentId?: string;
}

export interface EscalationOutcome {
  trigger: EscalationTrigger;
  escalationId: string;
  /** Resident-facing reply — always says the message was forwarded, never implies the AI resolved it. */
  replyText: string;
}

/**
 * Records an escalation for an already-known trigger and returns the
 * resident-facing reply. Low-level — prefer `checkMandatoryEscalation` /
 * `escalateUnknownAnswer` / `escalateForReason` below, which supply the
 * trigger and the `reason` text consistently.
 */
async function escalate(
  trigger: EscalationTrigger,
  text: string,
  context: EscalationContext,
  escalationModule: Pick<EscalationModule, 'escalate'>,
): Promise<EscalationOutcome> {
  const outcome = await escalationModule.escalate({
    reason: `${trigger}: ${text}`,
    sourceType: context.sourceType,
    sourceId: context.sourceId,
    message: text,
    ...(context.residentId ? { residentId: context.residentId } : {}),
  });
  return { trigger, escalationId: outcome.escalationId, replyText: outcome.replyText };
}

/**
 * Checks `text` against the mandatory escalation-trigger patterns (legal,
 * police, harassment, financial dispute — HLD Sec 16) and, if one matches,
 * creates the escalation and returns the outcome. Returns `null` if none
 * matched — callers must *not* treat `null` as "safe to answer normally"
 * on its own; the FAQ path still has to clear `escalateUnknownAnswer`'s
 * confidence gate separately.
 */
export async function checkMandatoryEscalation(
  text: string,
  context: EscalationContext,
  escalationModule: Pick<EscalationModule, 'escalate'>,
): Promise<EscalationOutcome | null> {
  const trigger = detectEscalationTrigger(text);
  if (!trigger) return null;
  return escalate(trigger, text, context, escalationModule);
}

/**
 * The `unknown_answer` mandatory trigger (HLD Sec 16) — called by the FAQ
 * path (modules/faq.ts) once knowledge search has run and found no
 * confident match (config/constants.ts `FAQ_MIN_CONFIDENCE_SCORE`). Unlike
 * the other triggers this isn't a text pattern; it's a fact about the
 * search result, so there's no `detect` step here — the caller already
 * knows.
 */
export async function escalateUnknownAnswer(
  text: string,
  context: EscalationContext,
  escalationModule: Pick<EscalationModule, 'escalate'>,
): Promise<EscalationOutcome> {
  return escalate('unknown_answer', text, context, escalationModule);
}

export interface GenericEscalationOutcome {
  escalationId: string;
  replyText: string;
}

/**
 * Escalates for a reason that isn't one of the five HLD Sec 16 trigger
 * patterns — e.g. a resident asking the AI to broadcast something
 * (residents can never trigger a broadcast, HLD Sec 16) or generic urgency
 * language `agent/intentRouter.ts` classified as `'escalation'` without
 * `guardrails.ts` matching a specific trigger. Still a mandatory
 * escalation — the AI still never answers directly — just not one that
 * fits the five-trigger taxonomy the `escalations` table's `reason`
 * (free text) is built for, precisely so cases like this don't need to be
 * force-fit into one. `modules/escalation.ts`'s `categorizeEscalation`
 * still assigns it one of the five `ESCALATION_CATEGORIES` (defaulting to
 * `committee_decision` when no sharper category applies).
 */
export async function escalateForReason(
  reason: string,
  context: EscalationContext,
  escalationModule: Pick<EscalationModule, 'escalate'>,
): Promise<GenericEscalationOutcome> {
  const outcome = await escalationModule.escalate({
    reason,
    sourceType: context.sourceType,
    sourceId: context.sourceId,
    message: reason,
    ...(context.residentId ? { residentId: context.residentId } : {}),
  });
  return { escalationId: outcome.escalationId, replyText: outcome.replyText };
}
