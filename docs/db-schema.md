# Database Schema

Source of truth for the schema is [`src/db/schema.ts`](../src/db/schema.ts)
(Drizzle ORM). This document explains _why_ each table exists, tying it back
to the HLD's functional modules (Section 6) and Resident Database (Section
7.5) / Memory Layer (Section 7.6). Regenerate the migration with
`pnpm db:generate` after changing the schema; apply it with `pnpm db:migrate`.

## Tables

### `residents` — HLD Sec 7.5 (Resident Database)

The master record for every unit in the society: `flat_number`, `name`,
`phone_e164`, `vehicles[]`, `emergency_contact`, `created_at`. Every other
resident-scoped table (`conversations`, `complaints`, `suggestions`) hangs
off `residents.id`.

**`phone_e164` and `emergency_contact` are field-level encrypted at rest**
(HLD Sec 15 — see [`docs/security.md`](security.md) and
`security/fieldEncryption.ts`): both columns hold AES-256-GCM ciphertext,
never plaintext, and only `tools/residentsTool.ts` is allowed to
read/write them directly. Since encryption is non-deterministic (a fresh
IV every time), `phone_e164` itself can no longer be queried by equality —
`phone_e164_hash`, a deterministic HMAC-SHA256 "blind index" of the
plaintext phone number, is what's actually unique/indexed and what every
inbound-WhatsApp-message-to-resident lookup queries.

### `conversations` — HLD Sec 7.6 (Memory Layer)

One row per WhatsApp thread with a resident (`whatsapp_thread_id`), so the
agent can maintain "remember previous conversations" (HLD Sec 2) context
without replaying the entire message table. `last_message_at` lets the
gateway cheaply find/resume the active thread for a resident.

### `messages` — HLD Sec 7.6 (Memory Layer)

The actual conversation history: every inbound/outbound message, who sent
it (`sender_type`: resident / ai / secretary), and any attached media. This
is what backs the AI's short-term context window and any human review of
what the AI said.

### `complaints` — HLD Sec 6.3 (Complaint Management), Sec 11 (Complaint Workflow)

Implements "Creates complaint → Generates Ticket ID → Saves in database →
Notifies secretary" (HLD Sec 6.3). `ticket_id` is the human-readable
identifier residents are given back (e.g. `TCK-2026-0001`); `status` moves
through `open → in_progress → resolved`, or `escalated` when it trips a
guardrail (HLD Sec 16). `flat_number` is denormalized onto the row (in
addition to `resident_id`) so tickets stay legible even if a resident record
is later edited.

### `suggestions` — HLD Sec 6.4 (Suggestion Management)

Resident-submitted suggestions, auto-categorized by the AI into
`maintenance | security | amenities | finance` — the same category set the
agent layer already uses (`config/constants.ts` `SUGGESTION_CATEGORIES`).

### `announcements` — HLD Sec 6.1 (Broadcast Management), Sec 9 (Broadcast Workflow)

Backs the human-in-the-loop broadcast pipeline: `draft` (secretary writing)
→ `pending_approval` (AI has improved formatting, awaiting sign-off) →
`approved` → `broadcast` (sent to the WhatsApp group). `approved_by` records
which secretary signed off — the AI is never allowed to move a row to
`approved` or `broadcast` itself (HLD Sec 16: AI cannot make committee/
broadcast-equivalent decisions unilaterally). `scheduled_at` supports
scheduled announcements (HLD Sec 6.1); `broadcast_at` is when it actually
went out, used to check the <30s broadcast-time NFR.

### `escalations` — HLD Sec 6.5 (Escalation Engine), Sec 16 (AI Safety Guardrails)

Every automatic forward to the human secretary — financial disputes, legal
matters, committee decisions, abuse, unknown questions — lands here.
`source_type` + `source_id` point at whatever triggered it (a complaint, a
resident query, or a suggestion); it's a polymorphic reference on purpose,
not a foreign key, since the source can be any of three tables.
`notified_secretary_at` is the audit trail proving the human was actually
notified, per the human-in-the-loop principle in `CLAUDE.md` Sec 2.

### `knowledge_documents` — HLD Sec 6.2 (FAQ Assistant), Sec 7.4 (Knowledge Base)

Catalog of the source-of-truth documents the FAQ assistant searches: Society
Handbook, Bye Laws, Parking Policy, Emergency Contacts, Maintenance Rules,
Clubhouse Rules. `source_uri` points at the document (currently a path
under `/docs/knowledge`; a GCS object path once ingestion moves off local
disk); `version` and `content_hash` (sha256 of the last-ingested content)
let `scripts/ingest-knowledge.ts` tell "unchanged" from "needs a version
bump + re-embedding" without diffing full text on every run — see
[`docs/memory-layer.md`](memory-layer.md). `source_uri` is unique so
re-ingesting the same file updates its existing row instead of duplicating
it.

### `knowledge_chunks` — HLD Sec 6.2, 7.4 (Knowledge Base — PGVector rows)

One row per embedded chunk of a `knowledge_documents` row, produced by
`scripts/ingest-knowledge.ts` and read by `PgVectorStore`
(`src/memory/vectorStore.ts`) when `VECTOR_DB_PROVIDER=pgvector` (the
default). `embedding` is a pgvector `vector(768)` column (768 = Gemini
`text-embedding-004`'s output size, `EMBEDDING_DIMENSIONS` in
`src/memory/embeddings.ts`); the `vector` extension is enabled by
`src/db/migrations/0001_knowledge_chunks.sql`. `category` is a denormalized
copy of the parent document's category so queries can filter without a
join, mirroring the metadata Chroma stores per-chunk when
`VECTOR_DB_PROVIDER=chroma` instead — this table is still populated in that
mode too, so document provenance stays queryable from SQL either way; only
similarity search itself goes to Chroma. `(document_id, chunk_index)` is
unique so re-ingesting a document upserts its chunks instead of duplicating
them.

### `audit_logs` — HLD Sec 15 (Security: Audit Logs)

Generic append-only log of who did what to which entity — required by the
HLD's security section regardless of module. `actor_type` distinguishes
resident/ai/secretary/system actions; `metadata` (jsonb) carries
action-specific detail (e.g. old/new status) without needing a new column
per event type.

## Indexes

Per the task requirements, indexes exist on every `phone_e164`, `ticket_id`,
and `status` column that a polling loop or lookup path touches:

| Table           | Index                                    | Reason                                                                                                                                                                         |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `residents`     | `residents_phone_e164_hash_idx` (unique) | Inbound WhatsApp messages are matched to a resident by phone number — via the blind-index hash, not the encrypted `phone_e164` column itself (HLD Sec 15, `docs/security.md`). |
| `residents`     | `residents_flat_number_idx`              | Secretary/admin lookups by flat.                                                                                                                                               |
| `complaints`    | `complaints_ticket_id_idx` (unique)      | Resident replies/status checks by ticket id.                                                                                                                                   |
| `complaints`    | `complaints_status_idx`                  | Polled by the secretary-notification job and any open-complaints dashboard.                                                                                                    |
| `escalations`   | `escalations_status_idx`                 | Polled by the secretary-notification job to find `pending` escalations.                                                                                                        |
| `announcements` | `announcements_status_idx`               | Polled by the broadcast scheduler for `pending_approval`/`approved` rows (must fire within the <30s NFR).                                                                      |

Additional indexes (foreign keys and thread lookups) were added where they
are the obvious access path even though not explicitly requested —
`conversations.whatsapp_thread_id` (unique), `conversations.resident_id`,
`messages.conversation_id`, `complaints.resident_id`,
`suggestions.resident_id`, `escalations(source_type, source_id)`,
`audit_logs(entity, entity_id)`, `knowledge_documents.source_uri` (unique),
`knowledge_chunks(document_id, chunk_index)` (unique), and
`knowledge_chunks.category`.

## Migrations

Migrations are Drizzle-generated SQL under
[`src/db/migrations/`](../src/db/migrations/), produced by `pnpm db:generate`
and applied by `pnpm db:migrate` (`src/db/migrate.ts`, using
`drizzle-orm/node-postgres/migrator`).

- `0000_wet_magik.sql` — the initial migration: `residents`, `conversations`,
  `messages`, `complaints`, `suggestions`, `announcements`, `escalations`,
  `knowledge_documents`, `audit_logs`, their enums, and the indexes above.
- `0001_knowledge_chunks.sql` — adds `knowledge_chunks` for the PGVector
  store. Starts with `CREATE EXTENSION IF NOT EXISTS vector;`, hand-added
  after `pnpm db:generate` since drizzle-kit has no concept of Postgres
  extensions — keep that line if this migration is ever regenerated.
- `0002_knowledge_documents_hash.sql` — adds `knowledge_documents.content_hash`
  and its `source_uri` unique index, used by the ingestion script's
  change-detection.
- `0003_nifty_roughhouse.sql` — adds `escalations.category` (HLD Sec 6.5's
  five-category taxonomy — [`docs/escalation-engine.md`](escalation-engine.md)),
  defaulted to `committee_decision` so it's safe to apply even with
  existing rows.
- `0004_lying_taskmaster.sql` — field-level encryption at rest (HLD Sec 15,
  [`docs/security.md`](security.md)): widens `residents.phone_e164`/
  `emergency_contact` to fit AES-256-GCM ciphertext, adds
  `phone_e164_hash` (the blind-index lookup column) as `NOT NULL`, and
  swaps the unique index from `phone_e164` to `phone_e164_hash`. **Safe
  only for an empty `residents` table** — see the migration file's own
  header comment for why and what a populated environment would need
  first.

> **Verified:** every migration above was generated (`pnpm db:generate`) and
> then actually applied with `pnpm db:migrate` against a throwaway
> `pgvector/pgvector:pg16` container (confirming `CREATE EXTENSION vector`
> and the `vector(768)` column work), followed by `pnpm db:seed` — all 10
> tables + indexes were created, and the seed produced the expected 5
> residents / 2 complaints / 1 escalation row (re-running the seed a second
> time inserted nothing new, confirming idempotency). `PgVectorStore` and
> `ConversationStore` were also exercised live against this database (see
> [`docs/memory-layer.md`](memory-layer.md)). The scratch container was
> removed afterward; it never touched the repo's own
> `docker/docker-compose.yml` stack. Structural assertions also live in
> `src/db/schema.test.ts`.

## Seeding

`pnpm db:seed` (implemented in [`scripts/seed.ts`](../scripts/seed.ts),
invoked by `scripts/seed.sh`) inserts:

- **5 residents** across flats A-101, A-403, B-204, B-702, C-305.
- **2 complaints**: a plumbing complaint for A-403 (`open`), and a security
  complaint for B-702 that is `escalated`, with a matching row in
  `escalations` — demonstrating the complaint → escalation link end to end.

The script is idempotent: residents are upserted on `phone_e164`, and a
complaint is skipped if one already exists for that flat, so re-running the
seed against the same database is safe.
