# Suggestion Management

Implements HLD Sec 6.4 (Suggestion Management):

```
Resident -> Suggestion -> AI Classifies -> Database -> Committee Reviews (async)
```

Split across two files, matching this repo's tool/module boundary
(`docs/agent-orchestration.md` — tools touch the database, modules decide
what to do and reply):

- **`tools/suggestionTool.ts`** — DB access only: creates a suggestion row.
  Also exports `categorizeSuggestion`, a pure keyword-based classifier used
  as a fallback (see below), plus its own default-classify-then-store path
  for any caller that doesn't need Gemini.
- **`modules/suggestions.ts`** — the actual HLD Sec 6.4 workflow: classify
  -> create -> acknowledge. `gateway/orchestrator.ts`'s `suggestion` intent
  branch is a thin call into this module (mirroring `modules/faq.ts`'s and
  `modules/complaints.ts`'s extraction pattern).

## Classification (`modules/suggestions.ts`)

Categories are fixed by `config/constants.ts`'s `SUGGESTION_CATEGORIES`:
`maintenance` / `security` / `amenities` / `finance` — the same four values
as the `suggestion_category` Postgres enum (`db/schema.ts`), so nothing a
classifier returns can be an invalid category to store.

### Constrained output, not prompt-only

The classifier is deliberately built so that "always one of the four
categories, never free text" is a property the **Gemini API itself
enforces**, not a hope encoded in the prompt wording:

```ts
const model = client.getGenerativeModel({
  model: config.model,
  generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: { type: SchemaType.STRING, enum: [...SUGGESTION_CATEGORIES] },
  },
});
```

With `responseSchema` set to a STRING schema with an `enum`, the Gemini API
constrains its own decoding to one of the listed tokens — the model
physically cannot emit a fifth category or a sentence, because the schema
is enforced server-side during generation, the same mechanism used for
structured JSON extraction. `parseClassifierOutput` unwraps the resulting
JSON-encoded string (e.g. `"security"`, quotes included) back to the bare
category.

As defense in depth (a test double, or an unexpected SDK/model version
returning something outside the four values), `createSuggestionClassifier`
still validates the result against `SUGGESTION_CATEGORIES` and falls back
to `'maintenance'` if it somehow isn't one of them — never stores a value
the `suggestion_category` enum would reject.

### Gemini failure -> keyword fallback

If the Gemini call itself throws (network error, missing/invalid key —
this sandbox has no real `GEMINI_API_KEY`, see "Verified live" below),
`modules/suggestions.ts`'s `createSuggestionModule` catches it and falls
back to `tools/suggestionTool.ts`'s keyword-based `categorizeSuggestion`
rather than losing the suggestion. This is a deliberate, narrower
resilience posture than `agent/guardrails.ts`'s forbidden-action checks or
`agent/escalation.ts`'s mandatory-escalation triggers, which must **never**
silently degrade — a suggestion is low-stakes (worst case: it lands in a
slightly wrong category for the Committee to re-file), so "categorized
slightly less precisely" beats "not recorded at all". The returned
`SuggestionOutcome.classifiedByGemini` flag records which path ran, for
observability/testing.

## The workflow (`modules/suggestions.ts`)

`submitSuggestion({ residentId, body })`:

1. **Classify** — Gemini constrained output, falling back to the keyword
   classifier on failure (above).
2. **Store** — `suggestionTool.createSuggestion` with the resolved
   category passed explicitly (so the tool's own default classifier is
   bypassed on this path; it remains available for any other caller).
3. **Acknowledge** — a brief, fixed-shape reply naming the category:
   `Thanks for the suggestion! I've recorded it under "<category>" for the
Committee to review.` No secretary notification — HLD Sec 6.4 describes
   this as an async Committee-review item, unlike Complaint Management's
   HLD Sec 11 workflow which does notify the secretary immediately.

## Testing strategy

- **`modules/suggestions.test.ts`**: `suggestionClassifierConfigFromEnv`
  (missing `GEMINI_API_KEY` throws); `createSuggestionClassifier` for each
  of the four categories via an injected `classifyImpl` returning a
  JSON-quoted string, an out-of-enum classifier result falling back to
  `'maintenance'`, and a plain-text (non-JSON) response still parsing via
  the trim fallback; `createSuggestionModule.submitSuggestion`'s full
  classify -> store -> acknowledge flow (asserting the exact
  `suggestionTool.createSuggestion` call and exact reply text) and the
  Gemini-failure -> keyword-fallback path (asserting `classifiedByGemini:
false` and that the keyword logic actually determined the category).
- **`gateway/orchestrator.test.ts`**: a suggestion-shaped message routed
  end to end through the orchestrator, asserting `suggestionTool
.createSuggestion` is called with the classifier's resolved category and
  the reply mentions it.

## Verified live (this session, not part of `pnpm test`)

A throwaway Postgres (Docker, `pgvector/pgvector:pg16` — plain `postgres`
doesn't have the `vector` extension this schema's migrations require) was
migrated and seeded, then a throwaway script exercised
`createSuggestionModule` against real Postgres with an injected
`classifyImpl` (no real `GEMINI_API_KEY` available in this sandbox, per the
same documented limitation as the Complaint Management and FAQ Assistant
phases):

- Four suggestions, one per category, each classified via a fake
  Gemini response and correctly stored under that category, with the
  expected acknowledgement text.
- A simulated Gemini failure (`classifyImpl` throwing) correctly fell back
  to the keyword classifier — "The garden and playground need better
  lighting" matched `amenities`, `classifiedByGemini` was `false`, and the
  suggestion was still stored rather than dropped.
- All five rows were confirmed present in the `suggestions` table
  afterward.

The scratch container was removed afterward; the repo's own
`docker/docker-compose.yml` stack and the unrelated `app1-db-1` container
from another project were not touched.
