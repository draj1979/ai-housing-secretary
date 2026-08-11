# Security (HLD Section 15)

HLD Sec 15's checklist, and where each item is actually implemented:

> HTTPS only · Encrypted secrets · Role-based access · JWT authentication ·
> Audit logs · Encrypted database · Daily backup · No resident data shared
> with the LLM unnecessarily · Human approval required for sensitive
> actions.

("Human approval required for sensitive actions" is HLD Sec 16's
guardrails/escalation system — [`docs/agent-orchestration.md`](agent-orchestration.md)
and [`docs/escalation-engine.md`](escalation-engine.md), not repeated here.)

## HTTPS only

`docker/nginx.conf`: port 80 does nothing but `return 301 https://...` —
there is no `location` block on that server that proxies anywhere, so
plain HTTP can't reach the gateway even by accident. Port 443 pins
`ssl_protocols TLSv1.2 TLSv1.3` (no TLS 1.0/1.1), a modern cipher list, and
sends `Strict-Transport-Security` (HSTS, 2-year max-age +
`includeSubDomains`) plus `X-Content-Type-Options` / `X-Frame-Options` /
`Referrer-Policy` on every response.

## Secrets: GCP Secret Manager, never committed files

`config/secrets.ts` + `config/env.ts`'s `loadEnvAsync`: when
`SECRETS_SOURCE=gcp`, every process boot (`gateway/index.ts`,
`inboundWorker.ts`, `broadcastWorker.ts` — each `isMain` block) fetches
`GEMINI_API_KEY`, `WHATSAPP_CLOUD_API_TOKEN`, `DATABASE_URL`, `JWT_SECRET`,
and `FIELD_ENCRYPTION_KEY` from Secret Manager (`GCP_SECRET_*` resource
names in `.env.example`) and overlays them onto whatever plaintext value
happened to also be set — Secret Manager always wins, so a stale `.env`
value can never silently take precedence over the real secret.

**`.env` is local-dev/test only.** `config/env.ts` loads it via
`dotenv/config` (a no-op if the file doesn't exist — safe in production,
where none should exist) purely for developer convenience. It is
`.gitignore`d and must **never** contain real production secrets — a
`.env` with a real Gemini/WhatsApp/JWT/encryption key checked into version
control, shared over chat, or left in a shared dev machine defeats the
entire point of Secret Manager. Production always sets
`SECRETS_SOURCE=gcp`; `.env`'s plaintext values are for pointing your own
laptop at a scratch Postgres/Redis and fake WhatsApp/Gemini credentials
during development, nothing more. See `.env.example` for the full variable
list with placeholder (never real) values.

## JWT auth + role-based access control for admin endpoints

`gateway/adminAuth.ts` + `gateway/adminRoutes.ts` — see their own doc
comments for the full design. Summary:

- Two roles (`ADMIN_ROLES`): `secretary` (full access) and `read_only`
  (view only, can never mutate).
- `requireAdminAuth` (Fastify `preHandler`) verifies
  `Authorization: Bearer <jwt>`, 401s otherwise.
- `requireRole(...)` 403s unless the token's role is in the allowed set —
  demonstrated on `gateway/adminRoutes.ts`'s two example routes: `GET
/admin/escalations` (either role) and `POST
/admin/escalations/:ref/status` (`secretary` only).
- Registered on the same Fastify app as the WhatsApp webhook
  (`gateway/index.ts`'s `createGateway`), but **only when `JWT_SECRET` is
  set** — a deployment that doesn't want this HTTP surface at all simply
  omits it and `/admin/*` doesn't exist.
- Token issuance is deliberately out-of-band (`mintAdminToken` is a
  building block, not an HTTP login route) — the HLD doesn't specify an
  identity provider, so this doesn't invent one. `scripts/mint-admin-token.ts`
  (`pnpm admin:mint-token`) is the actual out-of-band issuance mechanism —
  run once per secretary, the token handed to them directly, never logged
  or committed.

This mechanism now protects "a future committee dashboard" (HLD Sec 15's
own phrasing) for real: `gateway/adminDashboard.ts` +
`adminDocumentsRoutes.ts` + `adminResidentsRoutes.ts`, the document
upload / resident roster admin surface described in
[`docs/admin-dashboard.md`](admin-dashboard.md) — same `requireAdminAuth`/
`requireRole` mechanism as `adminRoutes.ts`'s escalations routes, no new
auth code.

## File upload (admin document upload)

`gateway/adminDocumentsRoutes.ts`'s `POST /admin/documents` is the only
route in this app that accepts an arbitrary uploaded file, so it gets its
own layer of validation beyond the standard JWT + `secretary`-role check:

- **Mimetype allowlist** — `modules/documentTextExtraction.ts`'s
  `SUPPORTED_UPLOAD_MIME_TYPES` (`text/plain`, `text/markdown`,
  `application/pdf` only); anything else 415s before the file is even
  buffered into memory beyond what `@fastify/multipart` already read.
- **Size cap** — `request.file({ limits: { fileSize } })`,
  `DEFAULT_MAX_UPLOAD_BYTES` (20MB); `@fastify/multipart` itself rejects
  the stream once the limit is hit, bounding one request's memory and
  downstream embedding cost.
- **No arbitrary code execution surface** — PDF text extraction is
  `pdf-parse`'s `getText()` (text extraction only, no PDF rendering/
  JS-execution path); there is no image processing, no shell-out to any
  external tool on the uploaded bytes.
- **Storage** — uploaded bytes go to GCS (`modules/documentStorage.ts`,
  Application Default Credentials, no key file) under a UUID-prefixed
  object path (`safeFilename` strips unsafe characters and truncates the
  original filename first) — never written to local disk on the gateway
  VM.
- **`secretary`-only** — no `read_only` upload/delete path exists (see
  this file's own doc comment); listing is the only `read_only`-accessible
  document route.

## A correctness bug that was also a security-relevant one

`gateway/webhook.ts` used to register its raw-buffer `application/json`
content-type parser (needed so WhatsApp signature verification hashes the
exact bytes Meta signed) directly on the shared top-level Fastify
instance instead of an encapsulated child plugin. That silently broke JSON
body parsing for **every other route on the same app**, including every
`/admin/*` JSON POST (`adminRoutes.ts`'s escalation-status update,
`adminResidentsRoutes.ts`'s resident upsert) — `request.body` arrived as a
raw `Buffer` instead of the parsed object those routes' validation logic
expects. In practice this mostly manifested as those routes silently
misbehaving (e.g. `"flatNumber" is required` on a request that clearly
included it) rather than an auth bypass — but any hand-rolled body
handling downstream of a broken parser is the kind of thing that
_could_ have silently accepted or misread admin input, which is why it's
called out here rather than only in [`docs/admin-dashboard.md`](admin-dashboard.md).
Fixed by encapsulating `webhook.ts`'s parser/routes in their own
`app.register(async (instance) => {...})` context; regression-tested by
`gateway/webhookEncapsulation.test.ts`, which registers webhook + admin
routes on one shared instance (matching real production topology) and
would fail against the pre-fix code.

## Audit logs: every tool call that touches resident data or triggers a broadcast/escalation

`agent/guardrails.ts`'s `AuditLogWriter` — four write paths, all going
through `audit_logs` (`actor_type`/`actor_id`, `action`, `entity`/`entity_id`,
`metadata`, `created_at`):

| Trigger                                       | Method                      | `action`                                          |
| --------------------------------------------- | --------------------------- | ------------------------------------------------- |
| Forbidden-action request blocked (HLD Sec 16) | `logForbiddenActionBlocked` | `blocked_forbidden_action`                        |
| Broadcast sent (HLD Sec 6.1)                  | `logBroadcastSent`          | `broadcast_sent`                                  |
| Complaint filed (`modules/complaints.ts`)     | `logAction`                 | `complaint_created`                               |
| Suggestion filed (`modules/suggestions.ts`)   | `logAction`                 | `suggestion_created`                              |
| Escalation created (`modules/escalation.ts`)  | `logAction`                 | `escalation_created`                              |
| Escalation acknowledged/resolved              | `logAction`                 | `escalation_acknowledged` / `escalation_resolved` |

`created_at` (`defaultNow()`) is "when" for every row — no separate
timestamp field needed. `actor_id` resolves to a stable resident id (via
`tools/residentsTool.ts`'s encrypted-phone lookup, not a raw phone number)
wherever the actor is a resident, or the secretary's `phone_e164` for
secretary-initiated actions (approvals, acknowledgements).

**Deliberately not logged**: read-only lookups (a status check, an admin
`GET /admin/escalations`) — this audit trail is scoped to writes/actions
with a real consequence, matching the HLD's "tool call that touches
resident data **or triggers** a broadcast/escalation" framing (a status
check touches resident data too, but doesn't change anything).

## Field-level encryption at rest for resident PII

`security/fieldEncryption.ts` + `tools/residentsTool.ts` — AES-256-GCM,
app-layer (not pgcrypto), for `residents.phone_e164` and
`residents.emergency_contact`. See those two files' doc comments for the
full design; summary:

- **Why app-layer over pgcrypto**: keeps the encryption format in one
  typed TypeScript module this codebase controls, instead of spread across
  raw SQL (`pgp_sym_encrypt`/`pgp_sym_decrypt` calls) in every insert/select
  that touches these columns.
- **Non-deterministic** (AES-GCM, random IV per call) — the same phone
  number encrypts to different ciphertext every time, so an attacker with
  read access to the database can't correlate rows by ciphertext alone.
- **The lookup problem this creates, and its fix**: non-deterministic
  encryption means `WHERE phone_e164 = <ciphertext>` can never match — so
  `residents.phone_e164_hash`, a _deterministic_ HMAC-SHA256 "blind index"
  of the plaintext phone number, is what every lookup actually queries
  (unique index on the hash, not the ciphertext column). The encrypted
  column itself is only ever decrypted after a row is already found some
  other way.
- **`tools/residentsTool.ts` is the only code allowed to touch these two
  columns directly** — `agent/guardrails.ts` (resolving an actor id for
  audit logging), `gateway/inboundWorker.ts` (resolving which resident just
  messaged, on every single inbound event), `tools/broadcastTool.ts`
  (decrypted recipient list), and `tools/escalationTool.ts` (decrypted
  resident context for the secretary notification) all go through it
  rather than querying `residents.phone_e164`/`emergency_contact`
  themselves.
- **Migration caveat**: `db/migrations/0004_lying_taskmaster.sql` is safe
  only for an empty `residents` table (a fresh install) — see that
  migration's own header comment for what a populated environment would
  need (a backfill script, not included, since this repo has never had a
  real deployment with real resident data).

## No resident data shared with the LLM unnecessarily

Two mechanisms, `agent/piiRedaction.ts`'s doc comment covers both in
detail:

1. **Structural**: `agent/gemini.ts`'s `generateReply` only ever accepts
   plain message text (`userMessage: string`, `history: GeminiContent[]`)
   — nothing upstream ever serializes a resident's phone number, emergency
   contact, or other profile fields into a prompt. There's no
   resident-shaped object on the path to Gemini to strip fields from.
2. **Redaction of the message text itself**: `redactPhoneNumbers` strips
   phone-number-shaped substrings from `userMessage` and conversation
   history _before_ they're sent to Gemini (only the payload actually
   transmitted to the API — the original text is untouched everywhere else:
   the WhatsApp reply, `conversationStore`, `audit_logs`). Scoped
   specifically to the FAQ path (`agent/gemini.ts`), where the answer is
   grounded only in retrieved knowledge-base chunks and doesn't need the
   resident's exact wording to contain a phone number. **Deliberately not
   applied** to `modules/broadcast.ts`'s language-improver input — an
   announcement may legitimately need to include a real contact number,
   and redacting there would corrupt the secretary's actual content rather
   than protect anyone's data.

## Daily encrypted backup

`scripts/backup.sh` — see [`docs/runbooks/backup-restore.md`](runbooks/backup-restore.md)
for the full pipeline, scheduling, and restore steps (including a
verified-live end-to-end backup/restore run against real Postgres).

## Verified live (this session, not part of `pnpm test`)

See each section's own module/doc comment and
[`docs/runbooks/backup-restore.md`](runbooks/backup-restore.md)'s
"Verified live" — summarized: field-level encryption round-trips through
real Postgres (encrypt, decrypt, blind-index lookup, wrong-key rejection),
`AuditLogWriter.logForbiddenActionBlocked` correctly resolves a resident's
`actor_id` through the encrypted lookup, and the backup/restore pipeline
reproduces the original `pg_dump` byte-for-byte through encrypt → decrypt →
restore into a fresh database.
