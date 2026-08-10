/**
 * agent/intentRouter.ts
 *
 * Intent detection for inbound resident messages (HLD Sec 8, Agent
 * Workflow: Webhook -> Gateway -> Intent Detection -> Tool Selection ->
 * Knowledge Search -> Gemini -> Response; see gateway/orchestrator.ts for
 * the full pipeline this feeds into).
 *
 * Intents expected per HLD Sec 6: broadcast, faq, complaint, suggestion,
 * escalation. Deliberately a small deterministic keyword classifier rather
 * than a Gemini call — fast, free, and testable without an API key; the
 * LLM's job downstream is answering FAQs and improving broadcast language,
 * not routing. `agent/guardrails.ts`'s `detectEscalationTrigger` is checked
 * *before* this in the orchestrator and always overrides it.
 */

export type Intent = 'broadcast' | 'faq' | 'complaint' | 'suggestion' | 'escalation';

// Order matters: checked top to bottom, first match wins. "escalation" here
// catches general urgency/severity language that guardrails.ts's more
// specific per-trigger patterns might not (e.g. "urgent", "emergency")
// without itself trying to classify *which* trigger it is — that's
// guardrails.ts's job.
const INTENT_PATTERNS: ReadonlyArray<{ intent: Intent; pattern: RegExp }> = [
  {
    intent: 'complaint',
    pattern:
      /\b(complain(t)?|broken|leak(ing|age)?|not working|stopped working|repair|please fix|issue with|problem with|damaged|malfunction(ing)?)\b/i,
  },
  {
    intent: 'suggestion',
    pattern:
      /\b(suggest(ion)?s?|\bidea\b|recommend(ation)?|it would be (nice|great|good) if|please consider|feedback)\b/i,
  },
  {
    intent: 'broadcast',
    pattern: /\b(announce|broadcast|notify all|notice to (everyone|all residents))\b/i,
  },
  {
    intent: 'escalation',
    pattern: /\b(urgent(ly)?|emergency|escalate)\b/i,
  },
];

/**
 * Classifies free text into one of the HLD Sec 6 intents. Falls back to
 * `'faq'` — the default "resident asked a question, search the knowledge
 * base" path — for anything that doesn't match a more specific pattern,
 * matching HLD Sec 6.2's "Residents tag AI -> AI searches ... -> replies"
 * as the baseline behavior.
 */
export function detectIntent(messageText: string): Intent {
  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(messageText)) return intent;
  }
  return 'faq';
}
