/**
 * config/constants.ts
 *
 * Non-functional targets and fixed thresholds pulled from the HLD (Sec 17)
 * so they live in one typed place instead of being hardcoded across modules.
 * `NFR_TARGETS.averageResponseSeconds`/`broadcastTimeSeconds`/`minResidentCapacity`
 * are asserted against directly in src/e2e/*.e2e.test.ts's response-time
 * budget tests — see docs/test-coverage.md.
 */

export const NFR_TARGETS = {
  availabilityPercent: 99.9,
  averageResponseSeconds: 5,
  broadcastTimeSeconds: 30,
  minResidentCapacity: 1000,
  concurrentUsers: 500,
  databaseBackupIntervalHours: 24,
  logRetentionDays: 90,
} as const;

export const ESCALATION_TRIGGERS = [
  'legal_issue',
  'police_complaint',
  'harassment',
  'financial_dispute',
  'unknown_answer',
] as const;

export const AI_FORBIDDEN_ACTIONS = [
  'make_financial_decision',
  'approve_refund',
  'change_maintenance_amount',
  'change_resident_information',
  'create_committee_decision',
  'remove_complaint',
] as const;

export const SUGGESTION_CATEGORIES = ['maintenance', 'security', 'amenities', 'finance'] as const;

/**
 * Escalation Engine categorization (HLD Sec 6.5) — the taxonomy
 * `modules/escalation.ts`'s `categorizeEscalation` sorts every escalation
 * into, regardless of which subsystem raised it (guardrail trigger,
 * forbidden-action block, FAQ low confidence, or a generic reason).
 * Deliberately a different, coarser set than `ESCALATION_TRIGGERS` above —
 * e.g. `police_complaint` and `harassment` both become `abuse` here, and
 * `create_committee_decision`/`change_resident_information`/`remove_complaint`
 * (from `AI_FORBIDDEN_ACTIONS`) collapse into `committee_decision` — since
 * the secretary triaging a list of open escalations cares about *what kind
 * of human decision this needs*, not which pattern matched.
 */
export const ESCALATION_CATEGORIES = [
  'financial_dispute',
  'legal_matter',
  'committee_decision',
  'abuse',
  'unknown_question',
] as const;

/**
 * Minimum knowledge-base cosine-similarity score (memory/similarity.ts
 * scale) an FAQ answer's top match must clear before the AI Secretary will
 * answer from it. Below this, the guardrail in gateway/orchestrator.ts
 * escalates as `unknown_answer` (HLD Sec 16: "AI must escalate ... Unknown
 * answers") instead of letting Gemini improvise from a weak match.
 */
export const FAQ_MIN_CONFIDENCE_SCORE = 0.5;
