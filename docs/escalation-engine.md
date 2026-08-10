# Escalation Engine

Implements HLD Sec 6.5 (Escalation Engine) and consolidates HLD Sec 16
("AI must escalate") enforcement into one place: whatever subsystem
decides a message needs a human, `modules/escalation.ts` is what actually
categorizes it, records it, and notifies the secretary — full context,
never a silent drop.

## Split across two files (tool/module boundary)

- **`tools/escalationTool.ts`** — DB access + the WhatsApp notification
  (unlike most tools, this one's notification is coupled to the DB write,
  because it needs `notifiedSecretaryAt` on the same row and a resident
  lookup only the DB tier has). `createEscalation`, `acknowledgeEscalation`,
  `listOpenEscalations`.
- **`modules/escalation.ts`** — categorization (`categorizeEscalation`),
  ticket auto-linking, resident-facing reply text, and the one
  `escalate()`/`acknowledge()`/`listOpenEscalations()` entry point every
  other subsystem now calls into instead of touching the tool directly.

## Consolidating triggers from four subsystems

| Subsystem                  | Path into `modules/escalation.ts`                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Guardrails (Phase 3.2)** | `agent/guardrails.ts`'s forbidden-action block and `detectEscalationTrigger` -> `agent/escalation.ts`'s `checkMandatoryEscalation`/`escalateForReason` -> `escalate()`                                                                                                                                                         |
| **FAQ, low confidence**    | `modules/faq.ts`'s confidence gate -> `agent/escalation.ts`'s `escalateUnknownAnswer` -> `escalate()`                                                                                                                                                                                                                          |
| **Suggestions, rare**      | Not a separate code path: `gateway/orchestrator.ts` runs the mandatory-escalation check on _every_ resident message before intent-based routing, so a suggestion-shaped message that also matches a trigger (e.g. "the guard keeps harassing me, please add cameras") is caught here before `modules/suggestions.ts` ever runs |
| **Complaints**             | No complaint flow escalates on its own today, but a message that names a ticket id anywhere in its text gets that ticket linked automatically (`linkedTicketId` below), reusing `modules/complaints.ts`'s `extractTicketId`                                                                                                    |

`agent/escalation.ts` still owns _detection_ (pattern matching against
`ESCALATION_TRIGGERS`/`AI_FORBIDDEN_ACTIONS`) — that stays separate from
_creation_, same rationale as `docs/agent-orchestration.md`'s "Why two
separate modules (guardrails.ts vs escalation.ts)" section. What changed
is that its `escalate()` helper now calls `modules/escalation.ts`'s
`escalate()` instead of `tools/escalationTool.ts`'s `createEscalation`
directly — the detection -> consequence split is preserved, just with a
richer consequence.

## Categorization (HLD Sec 6.5)

`config/constants.ts`'s `ESCALATION_CATEGORIES` — `financial_dispute` /
`legal_matter` / `committee_decision` / `abuse` / `unknown_question` —
persisted as `escalations.category` (a new Postgres enum column,
migration `0003_nifty_roughhouse.sql`, defaulted to `committee_decision`).
Deliberately a _different, coarser_ taxonomy than `ESCALATION_TRIGGERS`
(`legal_issue` / `police_complaint` / `harassment` / `financial_dispute` /
`unknown_answer`) or `AI_FORBIDDEN_ACTIONS` — the secretary triaging a list
of open escalations cares about _what kind of human decision this needs_,
not which regex matched. `categorizeEscalation(reason)`:

1. Checks a leading `token:` prefix — the shape every existing caller's
   `reason` string already has (`` `${trigger}: ${text}` `` from
   `agent/escalation.ts`, `` `forbidden_action_request:${action}: ${text}` ``
   from the guardrail block) — and maps it via a fixed lookup table.
2. Falls back to keyword matching over the full text (lawyer/court ->
   `legal_matter`; police/harassment/threat -> `abuse`; refund/fee/budget
   -> `financial_dispute`) for reasons with no recognized prefix (e.g. a
   resident asking the AI to broadcast something).
3. Defaults to `committee_decision` — the safest catch-all for "needs a
   human decision but doesn't fit a sharper bucket".

A caller can also pass an explicit `category` to skip auto-categorization
entirely (`EscalateInput.category`).

## Notification — full context (HLD Sec 6.5)

`tools/escalationTool.ts`'s `createEscalation` builds one WhatsApp message
to `WHATSAPP_SECRETARY_NUMBER`:

```
⚠️ Escalation [legal_matter] (query)
Resident: Anita Deshmukh, Flat A-101 (+919820011001)
Related ticket: TCK-2026-0001
Message: "Regarding TCK-2026-0001, I will consult my lawyer if this isn't fixed by Friday."
Reason: legal_issue: Regarding TCK-2026-0001, I will consult my lawyer if this isn't fixed by Friday.
Ref: a57efaee
```

- **Resident** — looked up from `input.residentId` (name, flat, phone);
  omitted if no resident id was available (e.g. the secretary's own path).
- **Related ticket** — `input.ticketId`, if given, or auto-detected:
  `modules/escalation.ts`'s `escalate()` runs `extractTicketId` over the
  message/reason text before calling the tool, so a resident who mentions
  a ticket id inline gets it linked without any caller having to thread it
  through by hand.
- **Message** — the resident's original text, verbatim.
- **Ref** — the same 8-character uuid prefix used by `approve <ref>` /
  `ack <ref>` elsewhere in this app, for consistency.

Same resilience tradeoff as every other notify-on-write path in this repo
(`tools/complaintTool.ts`, `tools/broadcastTool.ts`): the escalation row is
recorded regardless of whether the WhatsApp send succeeds — `notifiedSecretaryAt`
is only set on success, but a failed notification never loses the record.

## Acknowledgement and resolution

`escalations.status`: `pending -> acknowledged -> resolved` (the secretary
can also jump straight to `resolved`). `gateway/orchestrator.ts`'s
existing `ack <ref>` / `resolve <ref>` command grammar now calls
`escalationModule.acknowledge(idPrefix, status)`, which formats the reply
text (`"Escalation <ref> marked <status>."`) — previously built inline in
the orchestrator; now centralized so any future caller gets the same
wording.

## "pending escalations" — the open-items query (HLD Sec 6.5)

New secretary command: `pending escalations` or `open escalations`
(case-insensitive) -> `escalationModule.listOpenEscalations()` ->
`tools/escalationTool.ts`'s `listOpenEscalations` (`status IN ('pending',
'acknowledged')`, newest first — "open" is broader than strictly
`pending` so an acknowledged-but-not-yet-resolved item doesn't silently
drop off the list). Formatted reply, one line per escalation:

```
2 open escalation(s):
• a57efaee [legal_matter] pending — legal_issue: Regarding TCK-2026-0001, I will consult my lawyer if this isn't fix…
• d3d792f8 [committee_decision] pending — Recurring security lapse — requires committee attention per HLD Sec 16.
```

An empty result replies `"No pending escalations."` rather than an empty
list, so the secretary gets an unambiguous answer either way.

## Testing strategy

- **`modules/escalation.test.ts`** (21 tests): `categorizeEscalation` for
  every trigger-token prefix, every forbidden-action-token prefix, the
  keyword fallback, and the `committee_decision` default; `escalate()`
  (auto-categorization + resident context forwarded to the tool, the
  unknown-answer-specific reply wording, an explicit `category` override,
  ticket-id auto-linking from the message text, and no `ticketId` key at
  all when none is found — `exactOptionalPropertyTypes` means this has to
  be checked, not just "falsy"); `acknowledge()`; `listOpenEscalations()`
  (formatted non-empty list, and the empty-list wording).
- **`agent/escalation.test.ts`** (8 tests, rewritten): the same
  `checkMandatoryEscalation`/`escalateUnknownAnswer`/`escalateForReason`
  coverage as before, now against a mocked `EscalationModule` instead of
  `EscalationTool` — plus a new test confirming `residentId` is forwarded
  when the context carries one.
- **`modules/faq.test.ts`**: unchanged coverage, `escalationTool` mock
  swapped for `escalationModule`.
- **`gateway/orchestrator.test.ts`**: the guardrail/harassment/unknown-answer
  tests updated for the richer `createEscalation` call shape (category,
  residentId, message); two new tests for `"pending escalations"` (returns
  the formatted list) and the empty-list wording.
- **`db/schema.test.ts`**: `escalation_category` enum kept in sync with
  `config/constants.ts` `ESCALATION_CATEGORIES` (same pattern as
  `suggestion_category`).

## Verified live (this session, not part of `pnpm test`)

A throwaway Postgres (`pgvector/pgvector:pg16`, Docker) was migrated
(confirming the new `escalation_category` enum + column apply cleanly) and
seeded, then a throwaway script exercised the full pipeline against real
Postgres with a fake WhatsApp tool (no real Meta credentials in this
sandbox):

- **Guardrail-triggered legal escalation with a ticket reference**:
  `checkMandatoryEscalation` on a message naming both a lawyer and
  `TCK-2026-0001` correctly categorized as `legal_matter`,
  `notifiedSecretaryAt` was set, and the captured notification text
  included the resident's real name/flat/phone (looked up from Postgres)
  and the auto-linked ticket id.
- **FAQ low-confidence escalation**: `escalateUnknownAnswer` correctly
  categorized as `unknown_question`.
- **Acknowledge then resolve**: the legal escalation moved
  `pending -> acknowledged -> resolved`, each transition reflected
  immediately in `listOpenEscalations()`'s output (present while
  acknowledged, gone once resolved; the still-pending unknown-question
  escalation stayed listed throughout).
- **"pending escalations" alongside pre-existing seeded data**: the open
  list correctly included `scripts/seed.ts`'s own seeded escalation row
  alongside the two created during the script, confirming the query isn't
  scoped in a way that would hide unrelated open items.

The scratch container was removed afterward; the repo's own
`docker/docker-compose.yml` stack and the unrelated `app1-db-1` container
from another project were not touched.
