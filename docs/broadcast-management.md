# Broadcast Management

Implements HLD Sec 6.1 (Broadcast Management) and the Sec 9 workflow:

```
Secretary -> Private Chat -> Draft Announcement -> AI Improves Language ->
Approval -> Broadcast -> Residents
```

Split across three files, matching this repo's tool/module boundary
(`docs/agent-orchestration.md` — tools touch the database, modules decide
what to do and reply):

- **`tools/whatsappTool.ts`** — `broadcastMessage` fans a message out to
  every recipient with bounded concurrency (HLD Sec 17's <30s NFR); it now
  also accepts image/PDF attachments (`BroadcastContent`), not just text.
- **`tools/broadcastTool.ts`** — DB access only: drives all four
  `announcements.status` transitions (`draft -> pending_approval ->
approved -> broadcast`, or straight `pending_approval -> broadcast` for
  an unscheduled send). Does **not** decide _when_ to send or improve
  wording — that's `modules/broadcast.ts`.
- **`modules/broadcast.ts`** — the actual HLD Sec 9 workflow: improve ->
  draft -> preview, and approve -> send-or-schedule. `gateway/orchestrator.ts`'s
  secretary-command handling is a thin call into this module (mirroring
  `modules/faq.ts`'s extraction pattern).

## "AI Improves Language" (HLD Sec 9)

`modules/broadcast.ts`'s `createLanguageImprover` calls Gemini with a
plain-text prompt ("fix grammar/structure, keep every fact unchanged, don't
add information, return only the improved text") — free-form, not
constrained output like `modules/suggestions.ts`'s classifier, since an
announcement's wording isn't a fixed enum. Two safety nets:

- **A blank/whitespace-only model response falls back to the original
  text** — `createLanguageImprover` never returns an empty preview.
- **A Gemini call failure falls back to the original wording** (`draftAnnouncement`
  catches it, sets `improvedByGemini: false`) rather than losing the draft —
  same resilience posture as `modules/suggestions.ts`'s classifier.

**The AI never sends anything.** `draftAnnouncement` always ends at a
_preview_ reply telling the secretary to `approve <ref>` — there is no code
path from drafting to a broadcast without that explicit human step (HLD Sec
16).

## Attachments (image + PDF)

`DraftAnnouncementInput` accepts:

- `imageAttachments` / `pdfAttachments: UploadMediaInput[]` — new media to
  upload (a `filePath` or `buffer`); the module calls
  `whatsapp.uploadImage`/`uploadPDF` to get a WhatsApp media id before
  drafting.
- `existingAttachments: BroadcastAttachment[]` — already-known media ids,
  skipping the upload step. `gateway/orchestrator.ts` uses this when the
  secretary's draft _is_ an image/document message: an inbound WhatsApp
  media id is reusable directly in an outbound send, so no re-upload is
  needed for media the secretary just sent.

`announcements.media_urls` is a flat `text[]` with no structured attachment
columns, so `tools/broadcastTool.ts` exports a small encoding —
`encodeAttachment`/`decodeAttachment` — to round-trip a
`{type, mediaId, filename?}` through it (`"image:<mediaId>"` /
`"document:<mediaId>:<filename>"`). `sendAndFinalize` (internal to the
tool) decodes them back into `BroadcastAttachment[]` when it actually sends.

## Approval and the <30s broadcast NFR (HLD Sec 17)

`approveAnnouncement({ idPrefix, approvedBy })` is the **only** path that
can result in a send — always triggered by an explicit `"approve <ref>"`
from the secretary's own WhatsApp number (`gateway/orchestrator.ts`'s
command grammar), never by the AI. Two outcomes:

1. **No schedule, or the schedule has already passed** — sends immediately.
   `tools/broadcastTool.ts`'s `approveAndSend` loads every resident and
   calls `whatsapp.broadcastMessage` once, fanned out across recipients
   with at most `WHATSAPP_BROADCAST_CONCURRENCY` (default 5) in flight at
   once — that bound, not sequential sending, is what keeps a
   `NFR_TARGETS.minResidentCapacity`-sized (~1000 resident) broadcast under
   the 30s target, and it was already in place before this phase
   (`tools/whatsappTool.ts`'s `broadcastMessage`/`mapWithConcurrency`).
2. **Scheduled for the future** — `markApprovedForSchedule` flips status to
   `approved` (not `broadcast`) without sending, and the module hands the
   send off to a **queued job** (`deps.scheduler.scheduleBroadcast`) rather
   than blocking or polling.

## Scheduled announcements — a real queued job (HLD Sec 6.1)

`modules/broadcast.ts`'s `BroadcastScheduler` is a minimal seam
(`scheduleBroadcast(announcementId, runAt)`) so the module itself stays
unit-testable without Redis. The real implementation is
**`gateway/broadcastQueue.ts`**, mirroring `gateway/queue.ts`'s
inbound-webhook producer/consumer split:

- `createBroadcastScheduler(env)` — BullMQ producer; enqueues a job on the
  `broadcast-scheduled` queue **delayed** until `runAt` (BullMQ's native
  delayed-job support, not a polling loop). Uses the announcement's own id
  as the job id, so re-approving the same announcement replaces the
  pending job instead of double-scheduling it.
- **`gateway/broadcastWorker.ts`** — a separate process (own `pnpm
broadcast-worker` / `pnpm dev:broadcast-worker` scripts, mirroring
  `inboundWorker.ts`/`pnpm worker`) that consumes that queue and calls
  `BroadcastModule.runScheduledBroadcast(announcementId)` when the delayed
  job fires — which loads the `approved` row (already has `approvedBy`
  recorded from step 1 above), sends it via the same
  `whatsapp.broadcastMessage` fan-out as the immediate path, and flips
  status to `broadcast`.

Kept as its own worker process (not run inline in the HTTP server or the
inbound-webhook worker) for the same reason those are already split: a
broadcast send shouldn't compete with, or be starved by, inbound message
processing.

## Audit logging — who approved, when, recipient count (HLD Sec 6.1, 15)

Every successful send — immediate or scheduled — calls
`agent/guardrails.ts`'s `AuditLogWriter.logBroadcastSent`, which writes one
`audit_logs` row:

| HLD requirement | Column                                                            |
| --------------- | ----------------------------------------------------------------- |
| Who approved    | `actor_id` (+ `metadata.approvedBy`) — the secretary's phone_e164 |
| When            | `created_at` (`defaultNow()`) — no separate timestamp needed      |
| Recipient count | `metadata.recipientCount` (and `metadata.failedCount`)            |

`action: 'broadcast_sent'`, `entity: 'announcement'`, `entity_id`: the
announcement's id — same shape as `logForbiddenActionBlocked`'s existing
`audit_logs` rows, just a different action/entity. This runs for **both**
the immediate-send path (in `approveAnnouncement`) and the scheduled path
(in `runScheduledBroadcast`), so a scheduled broadcast that goes out hours
later is on record exactly like an immediate one.

## Secretary command grammar (`gateway/orchestrator.ts`)

Extends the existing `approve <ref>` / `ack`|`resolve <ref>` grammar:

| Pattern                                | Action                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `schedule <ISO-datetime> <text>`       | Drafts with `scheduledFor` set; an unparseable datetime replies with an error instead of silently dropping the schedule |
| _(anything else, including image/PDF)_ | Drafts immediately; an image/document message's caption is the body and its media is carried through as an attachment   |
| `approve <ref>`                        | `broadcastModule.approveAnnouncement` — sends now, or schedules, per above                                              |

## Testing strategy

- **`tools/whatsappTool.test.ts`**: `broadcastMessage` with a `BroadcastContent`
  (text + attachments) — text-then-each-attachment per recipient, an
  attachment-only send, and the "no text and no attachments" failure case —
  alongside the pre-existing text-only/concurrency/failure tests (still
  passing unchanged, since `content: string | BroadcastContent` is
  backward compatible).
- **`tools/broadcastTool.test.ts`**: `encodeAttachment`/`decodeAttachment`
  round-tripping (image, document-with-filename, document-defaulting its
  filename, and an unknown-prefix safe default). DB-touching behavior is
  covered by `modules/broadcast.test.ts` against a mocked `BroadcastTool`
  and by live verification below — same split as `tools/complaintTool.ts`.
- **`modules/broadcast.test.ts`** (15 tests): `createLanguageImprover`
  (improved text, blank-response fallback); `draftAnnouncement` (Gemini
  improvement applied and stored, Gemini-failure fallback, image/PDF
  upload-and-encode, `existingAttachments` skipping upload, `scheduledFor`
  passed through and mentioned in the preview); `approveAnnouncement`
  (immediate send + audit log, scheduled-in-the-future marks `approved`
  and schedules instead of sending, a past schedule sends immediately,
  not-found/wrong-status errors); `runScheduledBroadcast` (sends and logs).
- **`gateway/orchestrator.test.ts`**: secretary-path tests updated for the
  module-based flow (draft call now includes `mediaUrls: []`; approve goes
  through `getAnnouncement` first).

## Verified live (this session, not part of `pnpm test`)

A throwaway Postgres (`pgvector/pgvector:pg16`) + Redis (Docker) were
migrated/seeded, then a throwaway script exercised the full pipeline with a
fake WhatsApp tool (no real Meta credentials in this sandbox) and a fake
Gemini improve step (`` `[AI-formatted] ${raw}` ``, since no real
`GEMINI_API_KEY` is available either — same documented limitation as every
other module's live verification):

- **Draft with attachments**: an image + PDF upload were faked, the
  resulting `announcements.media_urls` row decoded back to exactly the two
  attachments that were uploaded, and the stored body carried the
  `[AI-formatted]` marker.
- **Immediate approve -> send -> audit**: `approveAnnouncement` sent to all
  5 seeded residents, the fake WhatsApp tool recorded exactly 5 sends, and
  an `audit_logs` row was confirmed with `actor_id` = the approving
  secretary's phone, `action: 'broadcast_sent'`, and
  `metadata.recipientCount: 5`.
- **Scheduled path, end to end with a real BullMQ delayed job**: a second
  announcement was drafted with `scheduledFor` 4 seconds out and approved
  — confirmed `status: 'approved'` (not yet sent) immediately after. A real
  BullMQ `Worker` on the exact `broadcast-scheduled` queue/job-data
  contract `gateway/broadcastWorker.ts` uses was started, and the delayed
  job was confirmed to fire and complete on its own — no polling from the
  script — flipping the announcement to `status: 'broadcast'` and writing
  a second `audit_logs` row (2 total, confirming both the immediate and
  scheduled paths log independently).

The scratch containers were removed afterward; the repo's own
`docker/docker-compose.yml` stack and the unrelated `app1-db-1` container
from another project were not touched.
