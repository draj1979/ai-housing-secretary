# OpenClaw Gateway: Session, Tools, Memory, Agent Orchestration

Implements HLD Sec 7.1 (OpenClaw Gateway) and Sec 8 (Agent Workflow), plus
the dual-number routing implied by the Sec 4 architecture diagram. The
composition root is `src/gateway/index.ts`'s `createOpenClawGateway()`.

## Two numbers, one webhook, one gateway (HLD Sec 4)

The society runs two WhatsApp Business numbers under one WABA, both
delivering to this app's single webhook (`gateway/webhook.ts`):

| Number                        | `config/env.ts`                      | Purpose                                                                         |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| **AI Secretary** (public)     | `WHATSAPP_PHONE_NUMBER_ID`           | Residents message this. The AI answers, logs complaints/suggestions, escalates. |
| **Human Secretary** (private) | `WHATSAPP_SECRETARY_PHONE_NUMBER_ID` | Approvals/escalations. A small command grammar, not the full agent pipeline.    |

Every inbound webhook message carries `metadata.phone_number_id`
(`tools/whatsappTool.ts`'s `WhatsAppInboundEvent.toPhoneNumberId`).
`gateway/inboundProcessor.ts` checks it against
`WHATSAPP_SECRETARY_PHONE_NUMBER_ID` _before_ doing anything else — a match
skips resident lookup and conversation-memory writes entirely and routes to
`orchestrator.handleSecretaryEvent`; everything else is the resident path
(`orchestrator.handleResidentEvent`).

**Why secretary messages aren't written to `memory/conversationStore.ts`:**
`conversations.resident_id` is a `NOT NULL` foreign key to `residents` — the
secretary isn't a resident, so there's no row for that FK to point at.
Rather than force a schema change for what is a fundamentally different
kind of conversation (commands, not chat), the secretary path uses
session management (below) but not conversation history.

## 1. Session management (`gateway/session.ts`)

Redis-backed, keyed by `phone_e164`, one JSON blob per active session:

```ts
getOrCreateSession({ phoneE164, role, whatsappThreadId, residentId? })
```

- **Idle timeout**: `SESSION_IDLE_TIMEOUT_SECONDS` (default 1800 = 30 min),
  implemented as the Redis key's TTL.
- **Resume-on-next-message**: if the key still exists, the _same_
  `sessionId` is returned (`resumed: true`) and the TTL is refreshed —
  that's what makes it an idle timeout rather than a fixed lifetime. If it
  expired, a new session (fresh `sessionId`, `resumed: false`) is created.
- `InMemorySessionStore` implements the identical interface for tests —
  same pattern as `memory/vectorStore.ts`'s `InMemoryVectorStore`.

This is deliberately separate from and much shorter-lived than
`memory/conversationStore.ts`'s permanent Postgres history: a session
answers "is this an ongoing interaction right now", not "what was ever
said".

## 2. Tool execution (`gateway/toolRegistry.ts`)

Six tools, one per HLD Sec 6 module, registered under one typed lookup:

| Tool              | File                           | What it does                                                                                                                                                                                                 |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `whatsapp`        | `tools/whatsappTool.ts`        | Send/reply/broadcast, media (already implemented — see `docs/whatsapp-integration.md`)                                                                                                                       |
| `knowledgeSearch` | `tools/knowledgeSearchTool.ts` | Embeds the query, top-k search against `memory/vectorStore.ts`                                                                                                                                               |
| `complaint`       | `tools/complaintTool.ts`       | Generates a ticket id, inserts into `complaints`                                                                                                                                                             |
| `suggestion`      | `tools/suggestionTool.ts`      | Inserts into `suggestions` under a caller-supplied category (falls back to its own keyword categorizer if none given)                                                                                        |
| `broadcast`       | `tools/broadcastTool.ts`       | Drives `announcements.status`: draft (`pending_approval`), immediate send (`broadcast`), or scheduled (`approved` -> `broadcast`) — see `modules/broadcast.ts` for the HLD Sec 9 workflow that decides which |
| `escalation`      | `tools/escalationTool.ts`      | Inserts into `escalations` (with a category), notifies the secretary over WhatsApp with full context, lists open escalations — see `modules/escalation.ts` for the categorization/consolidation policy       |

`createToolRegistry(tools)` just wraps a fixed set of already-constructed
tool instances with `.get(name)`/`.list()` — each tool takes its own
dependencies (mainly a `Database` and, where it needs to send a WhatsApp
message, the `whatsapp` tool instance) at construction time via
`createOpenClawGateway()`, not through the registry.

**Ticket-id generation** (`complaintTool.ts`) counts existing tickets for
the year then increments — the same approach `scripts/seed.ts` uses, with
the same known limitation: it's not race-safe under concurrent complaint
creation. Acceptable at this scale (a single society); would need an
advisory lock or a `SERIAL` sequence if that ever became a real problem.

**Suggestion categorization**: the live path (`modules/suggestions.ts`) uses
Gemini constrained output as the primary classifier — see "Suggestion
Management" below. `suggestionTool.ts`'s `categorizeSuggestion` is a small
keyword classifier used as that module's fallback when Gemini fails, same
design choice as intent detection below — deterministic, free, testable
without an API key.

## 3. Memory management

Already implemented (`docs/memory-layer.md`) — this phase just wires the
two pieces in:

- `memory/conversationStore.ts` — resident conversation history, read via
  `getRecentHistoryForPrompt()` for the FAQ path's Gemini call, written via
  `appendMessage()` for both the inbound message (already done by
  `inboundProcessor.ts` before the orchestrator runs) and the AI's reply
  (`orchestrator.ts`'s `replyAndRecord`).
- `memory/vectorStore.ts` — via `knowledgeSearchTool.ts`.

## 4. Agent orchestration (`gateway/orchestrator.ts`)

### Resident path — the HLD Sec 8 Agent Workflow

```
[Hard guardrail: forbidden-action block] -> [Mandatory escalation triggers]
  -> Intent Detection -> Tool Selection -> Knowledge Search -> Gemini -> Response
```

The two guardrail stages run _before_ intent detection, unconditionally,
for every message — not as branches inside the normal routing switch. HLD
Sec 16 treats these as safety requirements, not preferences, so they're
structurally first in the function, not one `case` among others a future
edit could accidentally reorder past.

0. **Hard guardrail: forbidden-action requests are BLOCKED, not just
   discouraged** (`agent/guardrails.ts`). `detectForbiddenActionRequest`
   pattern-matches the message against the six `AI_FORBIDDEN_ACTIONS` (HLD
   Sec 16: financial decisions, refund approvals, changing the maintenance
   amount, changing resident info, committee decisions, deleting a
   complaint) — phrased as _requests directed at the AI_ ("please reduce my
   maintenance"), not just any mention of the topic. A match:
   - Writes an `audit_logs` row (`enforceForbiddenActionGuardrail`,
     `actor_type: 'ai'`, `action: 'blocked_forbidden_action'`,
     `entity_id`: the specific action, `metadata`: the requested action +
     original text) — **before** anything else happens, so a blocked
     attempt is always on record, never just refused in a reply that could
     go unnoticed.
   - Still escalates (`agent/escalation.ts`'s `escalateForReason`) so the
     Secretary knows a resident asked — being blocked doesn't mean being
     ignored.
   - Replies with an explicit refusal ("I'm not able to ... myself — only
     the Secretary can do that.") — never a soft deflection.
   - **No tool call and no Gemini call happen for a blocked message** —
     `complaintTool`/`suggestionTool`/`suggestionClassifier`/`knowledgeSearchTool`/`geminiResponder`
     are all provably untouched (see `orchestrator.test.ts`'s refund test).
     `assertNotForbidden` (also in `guardrails.ts`) is the complementary
     guard for the _tool_ side: a synchronous throw any tool implementing one
     of these six actions must call first. No such tool exists today (they're
     intentionally never implemented), so it's a structural trip-wire against
     ever adding one that skips the check, not a live call site yet.
1. **Mandatory escalation triggers** (`agent/escalation.ts`'s
   `checkMandatoryEscalation`, wrapping `guardrails.ts`'s
   `detectEscalationTrigger`) — legal/police/harassment/financial-dispute
   language always creates an escalation and replies with "forwarded to the
   Secretary", regardless of what `agent/intentRouter.ts` would have
   classified the message as. The reply always says "forwarded" — it never
   answers the substance, matching the requirement that these are things
   "the agent must never attempt to answer... itself".
2. **Intent detection** (`agent/intentRouter.ts`'s `detectIntent`) — a
   deterministic keyword classifier (`complaint | suggestion | broadcast |
escalation | faq`, falling back to `faq`). Rule-based rather than a
   Gemini call: fast, free, and unit-testable without an API key — the LLM's
   job is answering FAQs and (eventually) improving broadcast language, not
   routing. **Checked after** a dedicated complaint-status-check —
   `modules/complaints.ts`'s `extractTicketId` looks for a ticket id (e.g.
   "status of TCK-2026-0001") _before_ this classifier runs and, if found,
   routes straight to a status lookup regardless of what `detectIntent`
   would have said — the keyword classifier's `complaint` pattern has no
   case for that message shape and would otherwise send it down the FAQ
   path. See [`docs/complaint-management.md`](complaint-management.md).
3. **Guardrail: residents can never trigger a broadcast** (HLD Sec 16), and
   `intentRouter.ts`'s own generic `'escalation'` bucket (urgency language
   that didn't match one of `guardrails.ts`'s specific trigger patterns) —
   both go through `escalation.ts`'s `escalateForReason` rather than being
   answered. Only the secretary's own number can start a broadcast (see
   below).
4. **Tool selection + execution**, per remaining intent:
   - `complaint` -> `modules/complaints.ts`'s `fileComplaint` (a new
     complaint — a ticket id was already ruled out above) — creates the
     ticket, notifies the secretary, replies with the ticket id.
   - `suggestion` -> `modules/suggestions.ts`'s `submitSuggestion` — classify
     (Gemini, falling back to the keyword classifier), create, reply with
     the category — see below.
   - `faq` (default) -> `modules/faq.ts`'s `answerQuestion` — see below.
5. Reply sent via `whatsappTool.replyMessage` (threaded to the original
   message), then recorded to conversation memory as `senderType: 'ai'`.

An event with no usable text (a bare reaction, an image with no caption)
skips the whole pipeline — no guardrail check, no tool call, no Gemini —
and gets a generic acknowledgement instead, to avoid wasting a
knowledge-search/Gemini call on empty input.

### FAQ Assistant (`modules/faq.ts`)

HLD Sec 6.2's dedicated module: "Resident tags AI -> AI searches Society
Rules / Maintenance Policy / Parking Rules / Clubhouse Rules -> replies."
`createFaqModule(deps).answerQuestion(question, history, escalationContext)`
is `gateway/orchestrator.ts`'s entire `faq` branch — the orchestrator just
calls it and uses `outcome.replyText`.

1. **Category-scoped search.** `FAQ_KNOWLEDGE_CATEGORIES` names exactly the
   four categories HLD Sec 6.2 lists — `bye_laws` ("Society Rules"),
   `maintenance_rules`, `parking_policy`, `clubhouse_rules` — deliberately
   narrower than the full six-category knowledge base (HLD Sec 7.4 also
   has `handbook` and `emergency_contacts`). One `knowledgeSearchTool.search`
   call runs _per category_ (four real queries, run in parallel), then
   results are merged and re-sorted by score and capped at `topK` (default 3) — so a strong match in one category can't be silently outcompeted by
   several mediocre matches from the unscoped top-k the way a single
   four-categories-pooled-then-truncated query might. This is the
   `docs/architecture.md` "Open questions" entry worth revisiting if real
   usage shows residents asking things the Handbook or Emergency Contacts
   should answer.
2. **Confidence gate, then either Gemini or escalation.** Same rule as
   before: top score `< FAQ_MIN_CONFIDENCE_SCORE` (0.5) or zero matches ->
   `agent/escalation.ts`'s `escalateUnknownAnswer` (HLD Sec 16 "unknown
   answers" — the "Phase 3.2 rule": no confident match means don't answer,
   escalate instead). Otherwise -> `agent/gemini.ts`'s `generateReply` with
   the merged matches as `knowledgeContext` and the resident's conversation
   history — Gemini is _only_ ever shown the retrieved chunks plus
   `agent/systemPrompt.ts`'s system instruction, never any outside
   knowledge, and the prompt requires citing which document an answer came
   from (`(Clubhouse Rules) ...` — see `agent/gemini.ts`'s `buildMessage`).
3. **Result shape carries the "why".** `answerQuestion` returns
   `{ replyText, answered, matches, escalationId? }` rather than just a
   string — `answered: false` plus `escalationId` when it didn't answer,
   `matches` always included (even on escalation, for logging/debugging
   what _was_ found but wasn't confident enough) — so a caller doesn't have
   to string-match the reply to know which path was taken.

### Suggestion Management (`modules/suggestions.ts`)

HLD Sec 6.4's dedicated module: classify -> store -> acknowledge.
`createSuggestionModule(deps).submitSuggestion({ residentId, body })` is
`gateway/orchestrator.ts`'s entire `suggestion` branch. See
[`docs/suggestion-management.md`](suggestion-management.md) for the full
design (constrained-output mechanism, keyword fallback, testing, live
verification) — in short: `createSuggestionClassifier` calls Gemini with a
`responseSchema` STRING `enum` of the four categories so the API itself can
only return one of `maintenance | security | amenities | finance`, never
free text; a Gemini-call failure falls back to
`tools/suggestionTool.ts`'s keyword classifier rather than losing the
suggestion.

#### Why two separate modules (`guardrails.ts` vs `escalation.ts`)?

`agent/guardrails.ts` is pure detection plus the one place that writes to
`audit_logs` — no knowledge of the `escalations` table or WhatsApp replies.
`agent/escalation.ts` is policy: given a detected trigger (or a
non-pattern-matched-but-still-mandatory reason), it decides what the
resident-facing reply says and delegates the actual record + notify to
`modules/escalation.ts` (HLD Sec 6.5 — see
[`docs/escalation-engine.md`](escalation-engine.md) for the full design:
categorization, ticket auto-linking, the "pending escalations" query).
Keeping detection and consequence separate means
`detectForbiddenActionRequest`/`detectEscalationTrigger` stay trivially
unit-testable pure functions (see `guardrails.test.ts`), while
`escalation.ts`'s tests focus on "does the right thing get created and
said" against a mocked `EscalationModule`, not string-matching.

### Secretary path — a command grammar, not the full pipeline

`handleSecretaryEvent` never runs intent detection or calls Gemini
directly (Gemini _is_ called, but only inside `modules/broadcast.ts`'s
language-improvement step, not for routing). Five cases, matched on the
message text:

| Pattern                                        | Action                                                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approve <ref>`                                | `broadcastModule.approveAnnouncement(ref, secretaryPhone)` — sends now, or marks `approved` and schedules a delayed job, depending on `scheduled_at` (below)      |
| `ack <ref>` / `resolve <ref>`                  | `escalationModule.acknowledge(ref, 'acknowledged' \| 'resolved')`                                                                                                 |
| `pending escalations` / `open escalations`     | `escalationModule.listOpenEscalations()` — every not-yet-resolved escalation, formatted with ref/category/status                                                  |
| `schedule <ISO-datetime> <text>`               | `broadcastModule.draftAnnouncement(...)` with `scheduledFor` set                                                                                                  |
| anything else (including an image/PDF message) | `broadcastModule.draftAnnouncement(...)` — AI-improved preview saved `pending_approval`; an image/document message's caption is the body, its media an attachment |

`<ref>` is the first 8 characters of the row's uuid (shown to the secretary
when a draft/escalation is created); `broadcastTool` and `escalationTool`
both resolve it via a `LIKE 'ref%'` prefix match rather than requiring the
full uuid. See [`docs/escalation-engine.md`](escalation-engine.md) for the
Escalation Engine's full design (HLD Sec 6.5).

See [`docs/broadcast-management.md`](broadcast-management.md) for the full
Broadcast Management design (HLD Sec 6.1, 9) — the "AI Improves Language"
step now runs (`modules/broadcast.ts`'s `createLanguageImprover`), the
scheduled-announcement queued job (`gateway/broadcastQueue.ts` +
`broadcastWorker.ts`), image/PDF attachment handling, and the
`audit_logs` row every broadcast writes (HLD Sec 15: who approved, when,
recipient count).

## Testing strategy

- **`src/e2e/guardrails.e2e.test.ts`** (43 tests) — the Phase 3.2 safety
  -boundary regression suite: every `AI_FORBIDDEN_ACTIONS`/text-pattern
  `ESCALATION_TRIGGERS` entry, multiple phrasings each, through the real
  orchestrator (not the pure detection functions in isolation — those are
  `guardrails.test.ts`, immediately below), plus precedence and
  false-positive negative cases. See
  [`docs/test-coverage.md`](test-coverage.md) for the full end-to-end
  suite this is one of.
- **Pure logic** (`agent/intentRouter.test.ts`, `agent/guardrails.test.ts`,
  `tools/suggestionTool.test.ts`'s `categorizeSuggestion` tests): no
  database, Redis, or network. `guardrails.test.ts` covers all six
  `detectForbiddenActionRequest` actions plus `enforceForbiddenActionGuardrail`
  against a mocked `AuditLogWriter` (asserting both the returned action and
  the exact audit-log call, and that ordinary messages write nothing).
- **`agent/escalation.test.ts`** (8 tests): `checkMandatoryEscalation` /
  `escalateUnknownAnswer` / `escalateForReason` against a mocked
  `EscalationModule` — the reason string format, the trigger-specific vs
  generic reply wording, that a non-matching message creates nothing, and
  that a resident id in the context is forwarded to `escalate()`.
- **`modules/escalation.test.ts`** (21 tests): `categorizeEscalation` for
  every trigger/forbidden-action prefix plus the keyword fallback and
  `committee_decision` default; `escalate` (auto-categorization, resident
  context forwarding, an explicit `category` override, ticket-id
  auto-linking, and no `ticketId` key when none is found); `acknowledge`;
  `listOpenEscalations` (formatted list, empty-list wording). See
  [`docs/escalation-engine.md`](escalation-engine.md).
- **`gateway/session.test.ts`**: `InMemorySessionStore`, including a
  fake-timers test proving the idle timeout actually expires a session.
- **`agent/gemini.test.ts`**: `createGeminiResponder` with an injected
  `generateImpl`, asserting the RAG-context prefixing — no real Gemini call.
- **`modules/faq.test.ts`** (9 tests): `createFaqModule` against mocked
  `knowledgeSearch`/`geminiResponder`/`escalationModule` — confirms all four
  `FAQ_KNOWLEDGE_CATEGORIES` are queried (not just the one with a hit),
  cross-category merge-and-sort ordering, the confidence gate (below/at/
  above threshold, and custom `minConfidenceScore`/`topK` overrides), that
  Gemini is grounded in exactly the retrieved chunks, and that a
  low-confidence or empty result escalates instead of calling Gemini.
- **`modules/suggestions.test.ts`**: `suggestionClassifierConfigFromEnv`,
  `createSuggestionClassifier` classifying each category via an injected
  `classifyImpl` plus the out-of-enum/plain-text fallback paths, and
  `createSuggestionModule.submitSuggestion`'s classify -> store ->
  acknowledge flow including the Gemini-failure -> keyword-fallback path.
  See [`docs/suggestion-management.md`](suggestion-management.md).
- **`tools/whatsappTool.test.ts`** / **`tools/broadcastTool.test.ts`** /
  **`modules/broadcast.test.ts`** (15 tests): `broadcastMessage`'s
  text+attachments fan-out; `encodeAttachment`/`decodeAttachment`
  round-tripping; `createLanguageImprover`'s fallback behavior;
  `draftAnnouncement`'s Gemini-improve/fallback, attachment upload, and
  scheduling; `approveAnnouncement`'s immediate-vs-scheduled branching and
  audit logging; `runScheduledBroadcast`. See
  [`docs/broadcast-management.md`](broadcast-management.md).
- **`gateway/orchestrator.test.ts`** (22 tests): the full resident and
  secretary pipelines against a fully mocked `ToolRegistry` +
  `conversationStore` + `InMemorySessionStore` + fake `geminiResponder` +
  fake `auditLog` — every intent branch, the broadcast/generic-escalation
  remap, the unknown-answer confidence gate, session resume, every
  secretary command (including `"pending escalations"`, both non-empty and
  empty), and two guardrail-specific tests matching the task's explicit
  requirements:
  - _"a prompt trying to get the agent to approve a refund is refused and
    logged"_ — asserts `auditLog.logForbiddenActionBlocked` was called with
    the exact action/text/actor, that an escalation was still created, that
    the reply text refuses explicitly, and that **no** complaint/suggestion
    tool call or Gemini call happened.
  - _"a harassment-related message triggers escalation instead of a direct
    AI reply"_ — asserts `escalationTool.createEscalation` was called with
    a `harassment`-tagged reason and `category: 'abuse'`, the reply says
    "forwarded", and `geminiResponder.generateReply` /
    `knowledgeSearchTool.search` were never called.
  - A loop test additionally confirms all four of the _other_
    `AI_FORBIDDEN_ACTIONS` (financial decision, maintenance amount,
    resident info, committee decision, remove complaint) are blocked with
    a correctly-populated audit log call and no Gemini call.
- **`gateway/inboundProcessor.test.ts`**: dual-number routing specifically
  — an event on the secretary number skips resident lookup/memory write
  entirely; one on the AI number doesn't; unset `secretaryPhoneNumberId`
  falls back to treating everything as resident-number (backward compatible
  with the pre-dual-number behavior).

## Verified live (this session, not part of `pnpm test`)

A throwaway Postgres + Redis pair (Docker) was migrated and seeded, then
the full pipeline was driven through real webhook payloads with a faked
`fetch` (no real Meta calls) and a faked Gemini responder (no API key
available in this sandbox — same limitation noted in
`docs/memory-layer.md`):

- **Complaint**: ticket `TCK-2026-000N` created, correct reply.
- **Suggestion**: categorized `maintenance`, correct reply.
- **Escalation** (triggered by "lawyer" -> `legal_issue`): escalation row
  created, secretary notified over WhatsApp, `notifiedSecretaryAt` set,
  resident told the ref. (This predates `modules/escalation.ts` — see
  [`docs/escalation-engine.md`](escalation-engine.md)'s own "Verified live"
  section for the categorized/ticket-linked/full-context version of this
  same flow, plus acknowledge/resolve and the "pending escalations" query,
  verified separately.)
- **Secretary draft -> approve -> broadcast**: draft saved
  `pending_approval`; `approve <ref>` resolved the short ref, broadcast
  the announcement to **all 5 seeded residents**, announcement flipped to
  `broadcast` with `approvedBy` set. (This predates `modules/broadcast.ts`
  — see [`docs/broadcast-management.md`](broadcast-management.md)'s own
  "Verified live" section for the AI-improved/attachments/scheduled-job/
  audit-log version of this same flow, verified separately.)
- **Session resume**: the same `sessionId` was returned on a second call
  for the same phone number.
- **FAQ path**: confirmed it reaches `memory/embeddings.ts`'s real Gemini
  embeddings call (and fails only there, on the fake API key) — proving
  intent detection -> tool selection -> knowledge search wiring is correct
  up to the one external dependency this sandbox can't provide.
- **Hard guardrail audit logging**: `enforceForbiddenActionGuardrail` run
  directly against real Postgres with `createAuditLogWriter(db)` — a
  refund-approval request was detected, and the resulting `audit_logs` row
  was confirmed to have `actor_type: 'ai'`, `actor_id` correctly resolved
  from the resident's phone to their uuid, `action: 'blocked_forbidden_action'`,
  `entity_id: 'approve_refund'`, and `metadata` carrying the original text
  — with exactly one row written, and zero for a follow-up ordinary
  message.
- **`modules/faq.ts` against real pgvector** (this session): four
  `knowledge_documents`/`knowledge_chunks` rows (one per
  `FAQ_KNOWLEDGE_CATEGORIES` entry) were inserted with hand-crafted
  768-dim embeddings (deterministic stand-ins for Gemini's, since no API
  key is available here) via the real `PgVectorStore`, then
  `createFaqModule` was driven through a `KnowledgeSearchTool` that runs
  real per-category `PgVectorStore.query()` calls (only the embedding
  computation itself was faked) plus a fake Gemini responder: a
  parking-shaped query embedding correctly retrieved the `parking_policy`
  chunk as the top match via real cosine-similarity ranking, correctly
  merged/capped results across all four real per-category queries, and
  correctly grounded the fake Gemini call in exactly those chunks with zero
  escalations created; a query embedding far from every stored vector
  correctly escalated as `unknown_answer` with the right reason string and
  zero Gemini calls.

Both scratch containers were removed afterward; the repo's own
`docker/docker-compose.yml` stack was not touched.
