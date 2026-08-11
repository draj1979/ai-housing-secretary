# Admin Dashboard — Document + Resident Management

A browser-based dashboard for the Human Secretary: upload society documents
(bye-laws, parking rules, maintenance rules, ...) so residents can ask the
AI Secretary about them, and maintain the resident roster (add/update/remove
name, flat number, phone, vehicles, emergency contact). This is the first
slice of the Roadmap's Phase 2 "Committee Dashboard" item (`CLAUDE.md`
Sec 11) — scoped deliberately narrow (documents + residents, the two things
a secretary asked for) rather than building out the full Phase 2 surface
at once.

Not a new module in `src/modules/` — it's a thin HTTP surface
(`gateway/adminDashboard.ts`, `gateway/adminDocumentsRoutes.ts`,
`gateway/adminResidentsRoutes.ts`) plus one new shared module
(`modules/documents.ts`) reusing existing building blocks: the same
chunk/embed/vector-store pipeline `scripts/ingest-knowledge.ts` already
had, `tools/residentsTool.ts`'s existing field-encryption-aware resident
CRUD, and `gateway/adminAuth.ts`'s existing JWT auth (the same
`secretary`/`read_only` roles already protecting `/admin/escalations`).

## Signing in

The dashboard's login screen (`GET /admin/dashboard`) is a real username +
password form, backed by `gateway/adminLoginRoutes.ts`'s `POST
/admin/login` — a single secretary account, not a multi-user system (the
HLD names no identity provider, and one account is what was actually
asked for). Set it up once:

```bash
pnpm admin:hash-password
```

Prompts for a password (hidden input, never echoed or logged), prints a
bcrypt hash — store that in Secret Manager, never the plaintext password:

```bash
printf '%s' '<hash the command printed>' | gcloud secrets versions add admin-password-hash --data-file=-
```

Set `ADMIN_USERNAME` (defaults `admin`) and
`GCP_SECRET_ADMIN_PASSWORD_HASH` in `.env` (see `.env.example`) — from
then on, signing in at `/admin/dashboard` with that username/password
mints a `secretary`-role JWT under the hood and stores it in the
browser's `localStorage`, same as before; nothing else about the API
calls changed. Login is rate-limited per IP (`adminLoginRoutes.ts`'s
`createLoginRateLimiter`) against brute-forcing.

`scripts/mint-admin-token.ts` still works as an out-of-band fallback
(scripting, or if the login endpoint itself is ever down):

```bash
pnpm admin:mint-token -- --sub "secretary@example-society.in" --role secretary
```

Either path produces the same kind of token — `Authorization: Bearer
<token>` on every `/admin/*` API call. A `read_only` token can view
documents but not upload; the resident roster is `secretary`-only end to
end (no HLD-specified read-only viewer role for resident PII) — the login
form only ever issues `secretary`-role tokens, since there's only the one
account.

## Using the dashboard

`GET /admin/dashboard` — a single self-contained HTML page (no build step,
no frontend framework, same "don't add a dependency for something simple"
instinct as `agent/intentRouter.ts`'s keyword classifier). Two tabs:

- **Documents** — list existing documents (title, category, version,
  upload date), upload a new one (title + category dropdown + file), delete
  one. Upload accepts `.txt`, `.md`, and `.pdf`, capped at 20MB. On upload,
  the file goes through the same pipeline `scripts/ingest-knowledge.ts`
  uses: text extraction → chunk → embed (Gemini) → upsert into the vector
  store → a `knowledge_documents` provenance row — so an uploaded bye-laws
  PDF becomes searchable by the FAQ Assistant within seconds, no separate
  ingestion step.
- **Residents** — list, add/update (`tools/residentsTool.ts`'s existing
  `upsert`, keyed by phone number — an existing resident's record updates
  in place when their phone number is resubmitted, otherwise a new row is
  created), delete. Phone number and emergency contact go straight through
  that tool's existing AES-256-GCM field encryption; the dashboard only
  ever sees/sends plaintext over the (secretary-only, JWT-authenticated)
  API — same boundary as every other caller of that tool.

## HTTP API

All routes require `Authorization: Bearer <admin JWT>` (`adminAuth.ts`).

| Method + path                 | Role                                                     | Notes                                                                                              |
| ----------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /admin/documents`        | `secretary`, `read_only`                                 | List documents + the six allowed categories.                                                       |
| `POST /admin/documents`       | `secretary`                                              | Multipart: `title`, `category`, `file`. Returns 201 + ingest result.                               |
| `DELETE /admin/documents/:id` | `secretary`                                              | Removes vector-store chunks, the DB row, and the GCS object. 404 if unknown id.                    |
| `GET /admin/residents`        | `secretary`                                              | Full roster, decrypted.                                                                            |
| `POST /admin/residents`       | `secretary`                                              | Upsert, keyed by phone number (create if new, update in place if it matches an existing resident). |
| `DELETE /admin/residents/:id` | `secretary`                                              | 404 if unknown id.                                                                                 |
| `GET /admin/dashboard`        | none (page itself; API calls from it still need a token) | Serves the HTML page.                                                                              |
| `POST /admin/login`           | none (this is how a token is obtained)                   | `{username, password}` → `{token}`. Rate-limited per IP.                                           |

Document categories are the six `KNOWLEDGE_CATEGORIES` HLD Sec 7.4 names
(`modules/documents.ts`): Society Handbook, Bye-Laws, Parking Policy,
Emergency Contacts, Maintenance Rules, Clubhouse Rules. Stored in
`knowledge_documents.category`, a plain `varchar` (not a Postgres enum),
so this list can grow without a migration.

## Deployment requirement

Document upload needs a GCS bucket
(`scripts/provision-gcp.sh` provisions one; wire it via `GCP_STORAGE_BUCKET`)
plus `GEMINI_API_KEY` (already required for the FAQ Assistant) — both are
resolved the same way every other secret is (`config/env.ts`,
`SECRETS_SOURCE=gcp`). If `GCP_STORAGE_BUCKET` isn't set, the gateway logs
a warning and mounts everything else (`/admin/dashboard`, `/admin/residents`,
`/admin/escalations`) without `/admin/documents` — the dashboard's
Documents tab will 404 on upload but the rest of the app still runs; this
matches `gateway/index.ts`'s existing pattern of only requiring the
credentials each optional surface actually needs, not gating the whole
gateway on the union of all of them.

## A bug this feature's live verification caught

Live-testing resident creation through the real composed gateway (not just
`adminResidentsRoutes.ts`'s own unit tests) surfaced a pre-existing bug in
`gateway/webhook.ts`: its `application/json` content-type parser
(`parseAs: 'buffer'`, needed so WhatsApp webhook signature verification
hashes the exact bytes Meta signed) was registered directly on the shared
top-level Fastify instance instead of inside an encapsulated child plugin.
That silently broke JSON body parsing for **every other route on the same
app** — `request.body` for `POST /admin/escalations/:ref/status` and the
new `POST /admin/residents` arrived as a raw `Buffer` instead of a parsed
object, in any real deployment (which always registers both webhook and
admin routes on one instance). Invisible to `webhook.test.ts` and
`adminRoutes.test.ts` individually, since each builds its own bare
`Fastify()` instance that never also registers the other file's routes.

Fixed by wrapping `webhook.ts`'s content-type parser and both of its routes
in `app.register(async (instance) => {...})` — see that file's own doc
comment for the full explanation. `gateway/webhookEncapsulation.test.ts` is
a new regression test that registers both webhook and admin routes on one
shared instance (matching real production topology) and asserts the admin
JSON POST parses correctly; confirmed via `git stash` that it fails against
the pre-fix code and passes with the fix.

## Testing

- `src/modules/documents.test.ts`, `documentTextExtraction.test.ts`,
  `documentStorage.test.ts` — pure logic (category validation, mimetype
  handling, GCS URI parsing).
- `src/gateway/adminDocumentsRoutes.test.ts`,
  `adminResidentsRoutes.test.ts` — route behavior against a fake
  `documentsModule`/`residentsTool` (the same injectable-module pattern
  `gateway/adminRoutes.ts`'s `escalationModule` established), including
  real `@fastify/multipart` payloads for the upload path.
- `src/gateway/webhookEncapsulation.test.ts` — the regression test above.
- **Verified live** (this session, not part of `pnpm test` — the two-tier
  testing convention this whole repo follows for anything touching a real
  DB/network): document upload → real GCS object → real Gemini embedding →
  real pgvector similarity search finding the uploaded content; PDF text
  extraction against a hand-built minimal PDF; resident create → real
  field-encryption round-trip through Postgres → decrypted on read →
  delete; auth checks (401 no token, 403 wrong role).
