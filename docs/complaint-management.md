# Complaint Management

Implements HLD Sec 6.3 (Complaint Management) and the Sec 11 workflow:

```
Resident -> Complaint -> AI -> Database -> Ticket Created ->
Secretary Notified -> Resident Gets Ticket
```

Split across two files, matching this repo's tool/module boundary
(`docs/agent-orchestration.md` — tools touch the database, modules decide
what to do and reply):

- **`tools/complaintTool.ts`** — DB access only: creates a complaint row
  (looking up and denormalizing the resident's flat number onto it),
  generates the ticket id, and looks one up by ticket id. Does **not**
  notify anyone — that's deliberate, so a caller can decide whether a given
  complaint needs anything beyond the database write.
- **`modules/complaints.ts`** — the actual HLD Sec 11 workflow:
  detect -> create -> notify -> confirm, plus the status-check flow.
  `gateway/orchestrator.ts`'s `complaint` intent branch is a thin call into
  this module (mirroring `modules/faq.ts`'s extraction pattern).

## Ticket id generation (`tools/complaintTool.ts`)

`TCK-{year}-{4-digit zero-padded sequence}`, e.g. `TCK-2026-0001`. Two
pieces:

- **`formatTicketId(year, sequence)`** — pure formatting/padding, exported
  standalone so it's unit-testable without a database
  (`complaintTool.test.ts`). Throws on a non-positive sequence; does _not_
  truncate a 5-digit sequence (`TCK-2026-10000` once a year passes 9999
  complaints) rather than silently colliding.
- **`nextTicketId(db, year)`** (internal) — counts existing tickets
  matching `TCK-{year}-%` and formats the next one. This count-then-insert
  is **not race-safe** under concurrent complaint creation — two
  simultaneous complaints could compute the same sequence number. Documented
  as a known, accepted limitation at this scale (a single society, not a
  high-frequency write path); a `SERIAL` column or advisory lock would be
  the fix if that ever became a real problem. Sequential _uniqueness_ under
  normal (non-concurrent) use was verified live — see "Verified live" below.

## The workflow (`modules/complaints.ts`)

### Detecting complaint intent

Two distinct signals, checked in `gateway/orchestrator.ts` before the
generic intent classifier runs:

1. **A ticket id in the message** (`extractTicketId`, pattern
   `TCK-\d{4}-\d{4}`, case-insensitive) — unambiguous signal that this is a
   **status check**, not a new complaint. Checked _before_
   `agent/intentRouter.ts`'s `detectIntent`, because that classifier's
   `complaint` pattern (keywords like "leak", "broken", "not working") has
   no case for "status of TCK-2026-0001" and would otherwise send it down
   the FAQ path by accident — a real gap this module's design closes,
   caught by writing the orchestrator-level test for it
   (`orchestrator.test.ts`'s status-check test).
2. Otherwise, `agent/intentRouter.ts`'s keyword classifier ("Water leakage
   in A-403", "the lift is broken", ...) — HLD Sec 6.3's example message.

### Filing a complaint (`fileComplaint`)

1. `complaintTool.createComplaint` — DB write, ticket id generated.
2. **Notify the secretary** over WhatsApp (`whatsapp.sendMessage` to
   `config/env.ts` `WHATSAPP_SECRETARY_NUMBER`) with the flat number,
   ticket id, and description. Same tradeoff as
   `tools/escalationTool.ts`'s `createEscalation`: the complaint is
   recorded regardless of whether the notification send succeeds — losing
   the DB record because WhatsApp was briefly unreachable would be worse
   than a missed notification. Omitting `secretaryNumber` from the
   module's deps (e.g. in tests) skips notification entirely rather than
   erroring.
3. **Confirm to the resident** — the ticket id, plus a hint that they can
   ask "status of `<ticket>`" later.

### Status check (`checkStatus`)

Looks up the ticket and returns its current status, **scoped to the
requesting resident** — a ticket that exists but belongs to someone else
returns the same `status_not_found` outcome as a ticket that doesn't exist
at all, rather than confirming its existence or leaking its status. Ticket
ids are sequential and not treated as secret, so without this check one
resident could page through recent ticket ids and read other residents'
complaint statuses.

### `handleMessage` — the one call the orchestrator needs

```ts
handleMessage(text, { residentId }); // -> checkStatus or fileComplaint, whichever text implies
```

Returns a `ComplaintOutcome` (`{ replyText, kind, complaint?, status? }`)
rather than a bare string — `kind` distinguishes `'filed'` /
`'status_found'` / `'status_not_found'` without the caller needing to
string-match the reply, same pattern as `modules/faq.ts`'s
`FaqAnswerResult`.

## Testing strategy

- **`tools/complaintTool.test.ts`**: `formatTicketId` — format/padding,
  uniqueness across a run of consecutive sequence numbers, distinctness
  across years, and rejection of a non-positive sequence. Pure, no database.
- **`modules/complaints.test.ts`** (16 tests): `extractTicketId` (status
  phrasing, embedded, bare, case normalization, non-matches, malformed
  ticket-id-shaped strings); `fileComplaint`'s full create -> notify ->
  confirm flow against mocked `complaintTool`/`whatsapp` (asserting the
  exact DB-write call, the exact secretary-notification content, and the
  confirmation reply — plus that filing still succeeds if notification is
  unconfigured or its send fails); `checkStatus` (found, resolved-with-date,
  not-found, and the cross-resident privacy scoping); `handleMessage`'s
  dispatch between the two flows.
- **`gateway/orchestrator.test.ts`**: a status-check message end to end
  through the orchestrator (proving the ticket-id-before-intent-detection
  routing actually works, not just the module in isolation), alongside the
  existing new-complaint routing test.

## Verified live (this session, not part of `pnpm test`)

A throwaway Postgres (Docker) was migrated and seeded (which itself creates
`TCK-2026-0001`/`0002`), then:

- **Ticket id uniqueness**: 10 complaints created in a real sequential loop
  against real Postgres produced `TCK-2026-0003` through `TCK-2026-0012` —
  all unique, correctly continuing the sequence after the seed data.
- **Full create -> notify -> confirm flow**: `handleMessage` on "Water
  leakage in A-403 again, please fix urgently" correctly filed
  `TCK-2026-0013`, sent the secretary a WhatsApp notification containing
  the flat number and ticket id, and confirmed the ticket id back to the
  resident.
- **Status-check flow**: the filing resident asking "status of
  TCK-2026-0013" got `status_found` with a correctly formatted reply; a
  _different_ seeded resident asking the same question got
  `status_not_found` — confirming the ownership scoping works against a
  real second resident row, not just a mocked one.

The scratch container was removed afterward; the repo's own
`docker/docker-compose.yml` stack was not touched.
