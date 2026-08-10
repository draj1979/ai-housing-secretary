/**
 * agent/piiRedaction.ts
 *
 * "No resident data shared with the LLM unnecessarily" (HLD Sec 15,
 * CLAUDE.md Sec 10 Security Baseline) — the concrete, code-level
 * enforcement of that principle for the one place resident-authored text
 * reaches Gemini: agent/gemini.ts's `generateReply`.
 *
 * Two complementary mechanisms in this codebase:
 *   1. **Never pass a resident record.** `GenerateReplyInput` only ever
 *      accepts `userMessage: string` / `history: GeminiContent[]` (plain
 *      message text) — nothing upstream (modules/faq.ts, gateway/orchestrator.ts)
 *      ever serializes a resident's phone number, emergency contact, or
 *      other profile fields into a prompt. There is no resident-shaped
 *      object anywhere on the path to Gemini for this to strip.
 *   2. **Redact PII patterns from the message text itself** (this file).
 *      A resident's FAQ question is answered purely from retrieved
 *      knowledge-base chunks (agent/gemini.ts's "never hallucinate" design
 *      — the model doesn't need the resident's exact wording to contain a
 *      phone number for that), so stripping phone-number-shaped substrings
 *      before the text reaches the model removes PII that was never needed
 *      for the tool call in the first place. Applied only to what's sent to
 *      Gemini — the original text is untouched everywhere else (WhatsApp
 *      replies, conversationStore, audit_logs).
 *
 * Deliberately **not** applied to modules/broadcast.ts's language-improver
 * input: an announcement's job is to inform residents, and it may
 * legitimately include a contact number ("call the plumber at +91...") —
 * redacting there would corrupt the secretary's actual content rather than
 * protect anyone's data. This module is scoped to the resident-facing FAQ
 * path specifically, where the exact wording doesn't need to survive intact.
 */

// Matches phone-number-shaped substrings: an optional "+", then 10-15
// digits with optional separating spaces/hyphens — deliberately broad
// (covers Indian mobile numbers, landlines with STD codes, and other
// residents' numbers a resident might paste into their own message)
// rather than precisely matching only E.164. The 10-digit floor is
// deliberate: shorter digit runs (a 4-digit ticket suffix like
// "TCK-2026-0001", a flat number like "A-403") are common in this app's
// own message shapes and must not be swept up as "phone-shaped".
const PHONE_PATTERN = /\+?\d[\d\-\s]{8,13}\d/g;

export const REDACTED_PHONE_PLACEHOLDER = '[redacted-phone-number]';

/** Replaces phone-number-shaped substrings in `text` with a placeholder. Pure — see piiRedaction.test.ts. */
export function redactPhoneNumbers(text: string): string {
  return text.replace(PHONE_PATTERN, REDACTED_PHONE_PLACEHOLDER);
}
