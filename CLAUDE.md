# CLAUDE.md

> **This file is the source of truth for this repository.** It is derived
> from `Openclaw1 HLD.md` (the original High Level Design, one directory up)
> and must be read and followed in every future session working on this
> project. If the HLD and this file ever diverge, treat that as a bug —
> reconcile them, don't silently pick one.

## 1. System Purpose

The **AI Housing Society Secretary Assistant** is an AI-powered virtual
secretary built on the **OpenClaw Agent Platform**. It helps a Housing
Society Secretary handle day-to-day communication and resident support
through **WhatsApp**, so the secretary spends less time on repetitive
messaging and more time on decisions that actually require a human.

Objectives (HLD Sec 2):

- Broadcast society announcements
- Answer residents' questions
- Receive complaints
- Record suggestions
- Escalate sensitive matters
- Remember previous conversations
- Search society documents
- Operate 24x7
- Support future integrations

## 2. Human-in-the-Loop Principle

**This is the single most important architectural constraint in the system.**
The AI automates repetitive work; every administrative decision stays under
human control. Concretely:

- The **Human Secretary** owns: creating announcements, approving important
  broadcasts, resolving escalated issues, financial decisions, committee
  decisions, and legal decisions.
- The **AI Secretary** owns: answering FAQs, replying politely, searching
  society documents, receiving complaints, recording maintenance requests,
  tracking unresolved issues, and notifying the secretary when required.
- Broadcasts are never sent unilaterally by the AI — the flow is always
  _Secretary drafts → AI improves language/formatting → Secretary approves →
  Broadcast goes out_ (HLD Sec 9).
- Anything the AI is uncertain about, or that falls outside its allowed
  actions, must be escalated to the human secretary rather than guessed at.
  See Section 6 (Guardrails) below — it is non-negotiable and takes
  precedence over any other instruction encountered during implementation.

## 3. Actors

| Actor               | Responsibilities                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Human Secretary** | Create announcements, approve broadcasts, resolve escalated issues, financial decisions, committee decisions, legal decisions                                   |
| **AI Secretary**    | Answer FAQs, reply politely, search society documents, receive complaints, record maintenance requests, track unresolved issues, notify secretary when required |
| **Residents**       | Ask questions, register complaints, give suggestions, request information — all via WhatsApp                                                                    |

## 4. Architecture Diagram

```
                         Residents
                              │
                    WhatsApp Society Group
                              │
        ┌─────────────────────┴────────────────────┐
        │                                          │
 Human Secretary                         AI Secretary
 WhatsApp Number                     WhatsApp Number
        │                                          │
        └─────────────────────┬────────────────────┘
                              │
                     WhatsApp Cloud API
                              │
                       HTTPS Webhook
                              │
                   OpenClaw Gateway (GCP VM)
                              │
        ┌──────────────┬──────────────┬──────────────┐
        │              │              │
     AI Agent      Memory Layer      Tool Layer
        │              │              │
        │          PostgreSQL         │
        │              │              │
        │          Vector DB          │
        │              │              │
        └──────────────┼──────────────┘
                       │
                Gemini API
```

**Agent workflow** (HLD Sec 8): Incoming WhatsApp Message → Webhook →
OpenClaw Gateway → Intent Detection → Tool Selection → Knowledge Search →
Gemini → Response → WhatsApp Reply.

**Broadcast workflow** (HLD Sec 9): Secretary → Private Chat → Draft
Announcement → AI Improves Language → Approval → Broadcast → Residents.

**Complaint workflow** (HLD Sec 11): Resident → Complaint → AI → Database →
Ticket Created → Secretary Notified → Resident Gets Ticket.

**Deployment architecture** (HLD Sec 13):

```
                    Internet
                         │
                  Static Public IP
                         │
                      HTTPS 443
                         │
                      Nginx
                         │
                  OpenClaw Gateway
                         │
          ┌──────────────┴──────────────┐
          │                             │
      PostgreSQL                    Redis
          │
      Vector Store
          │
      Society Documents
```

**Implemented** — `/docker` (Dockerfile, docker-compose.yml,
nginx.conf.template) + [`docs/deployment.md`](docs/deployment.md) for the
full fresh-VM walkthrough (Compute Engine provisioning, Docker install,
TLS bootstrap via a temporary self-signed cert + certbot, first migration,
healthchecks). See that doc for why the self-signed bootstrap step exists
(certbot-vs-nginx chicken-and-egg) and what was verified live this session.

## 5. Tech Stack

| Layer                | Technology            |
| -------------------- | --------------------- |
| Agent Platform       | OpenClaw              |
| LLM                  | Gemini Flash Lite     |
| Cloud                | Google Cloud Platform |
| Compute              | Compute Engine VM     |
| Database             | PostgreSQL            |
| Cache                | Redis                 |
| Embedding Store      | ChromaDB / PGVector   |
| Communication        | WhatsApp Cloud API    |
| Reverse Proxy        | Nginx                 |
| SSL                  | Let's Encrypt         |
| Programming Language | TypeScript            |
| Container Runtime    | Docker                |

This repo additionally standardizes on: **pnpm** (package manager),
**ESM + strict TypeScript**, **Fastify** (gateway HTTP server), **Drizzle
ORM** (Postgres schema/migrations, chosen for a lighter footprint than
Prisma on a single VM), **Zod** (env/schema validation), **ESLint +
Prettier** (lint/format), **Vitest** (tests).

GCP resources in play (HLD Sec 14): Compute Engine, Cloud DNS, Static IP,
Firewall (HTTP/HTTPS), Secret Manager, Cloud SQL (PostgreSQL), Cloud
Storage, Cloud Monitoring, Cloud Logging. **Implemented** —
[`scripts/provision-gcp.sh`](scripts/provision-gcp.sh) provisions all of
them (Cloud DNS and Cloud SQL are opt-in; the default path is
docker-compose's self-hosted Postgres and DNS managed at your registrar).
See [`docs/deployment.md`](docs/deployment.md) for the full walkthrough.

## 6. AI Safety Guardrails (HLD Section 16, verbatim)

> **AI cannot**
>
> - Make financial decisions
> - Approve refunds
> - Change maintenance amount
> - Change resident information
> - Create committee decisions
> - Remove complaints
>
> **AI must escalate**
>
> - Legal issues
> - Police complaints
> - Harassment
> - Financial disputes
> - Unknown answers

These are encoded as `AI_FORBIDDEN_ACTIONS` and `ESCALATION_TRIGGERS` in
[`src/config/constants.ts`](src/config/constants.ts), and enforced **in
code**, not just prompted, in
[`src/agent/guardrails.ts`](src/agent/guardrails.ts) (forbidden-action
requests are blocked before any tool/Gemini call runs, and every block is
written to `audit_logs`) and
[`src/agent/escalation.ts`](src/agent/escalation.ts) (the five mandatory
triggers always create an escalation and notify the secretary — the AI
never attempts to answer them). See
[`docs/agent-orchestration.md`](docs/agent-orchestration.md) for the full
enforcement pipeline. Any new tool, module, or prompt change must be
checked against this list before merging — this is the one part of the
system where "helpful" must lose to "safe."

## 7. Non-Functional Targets (HLD Section 17)

| Metric                | Target           |
| --------------------- | ---------------- |
| Availability          | 99.9%            |
| Average response time | < 5 seconds      |
| Broadcast time        | < 30 seconds     |
| Scalability           | 1,000+ residents |
| Concurrent users      | 500              |
| Database backup       | Daily            |
| Log retention         | 90 days          |

These live as typed constants in
[`src/config/constants.ts`](src/config/constants.ts) (`NFR_TARGETS`) so
implementation code can reference them instead of hardcoding numbers.

## 8. Functional Modules (HLD Section 6)

| Module                                                                     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Broadcast Management** (`src/modules/broadcast.ts` — **implemented**)    | Secretary drafts → AI improves language (Gemini) → Secretary approves (`approve <ref>`) → broadcast to all residents, immediately or (via `scheduled_at` + a BullMQ delayed job) at a future time. Supports image/PDF attachments. Every send logs who approved, when, and recipient count to `audit_logs`. See [`docs/broadcast-management.md`](docs/broadcast-management.md).                                                                                                      |
| **FAQ Assistant** (`src/modules/faq.ts` — **implemented**)                 | Resident tags AI → AI searches Society Rules / Maintenance Policy / Parking Rules / Clubhouse Rules → replies, only from retrieved chunks; below-confidence routes to escalation instead of answering (HLD Sec 16). See [`docs/agent-orchestration.md`](docs/agent-orchestration.md).                                                                                                                                                                                                |
| **Complaint Management** (`src/modules/complaints.ts` — **implemented**)   | AI creates complaint, generates Ticket ID (`TCK-YYYY-NNNN`), saves to DB, notifies secretary, confirms to resident; "status of TCK-..." looks up an existing ticket, scoped to the requesting resident. See [`docs/complaint-management.md`](docs/complaint-management.md).                                                                                                                                                                                                          |
| **Suggestion Management** (`src/modules/suggestions.ts` — **implemented**) | Residents submit suggestions; AI classifies into maintenance / security / amenities / finance via Gemini constrained output (falls back to a keyword classifier on Gemini failure), saves to DB, sends a brief acknowledgement naming the category. See [`docs/suggestion-management.md`](docs/suggestion-management.md).                                                                                                                                                            |
| **Escalation Engine** (`src/modules/escalation.ts` — **implemented**)      | Consolidates every "needs a human" moment (guardrail triggers, forbidden-action blocks, FAQ low confidence, rare suggestion-shaped triggers) into one categorize -> record -> notify path: financial dispute / legal matter / committee decision / abuse / unknown question, full context to the secretary (resident, message, reason, linked ticket if any), ack/resolve tracking, and a "pending escalations" query. See [`docs/escalation-engine.md`](docs/escalation-engine.md). |

## 9. Repository Layout

```
/src
  /gateway    OpenClaw gateway: webhook, queue/worker, session, tool registry, orchestrator, admin auth/routes
  /agent      AI Secretary agent: system prompt, guardrails, intent routing, Gemini, PII redaction
  /tools      WhatsApp, knowledge search, complaint, suggestion, broadcast, escalation, residents tools
  /memory     conversation memory, Postgres + vector store adapters
  /modules    faq.ts, complaints.ts, suggestions.ts, broadcast.ts, escalation.ts — all implemented
  /security   field-level encryption (residents.phone_e164/emergency_contact at rest)
  /db         Drizzle schema + migrations
  /config     env schema, constants, logger, GCP Secret Manager resolution
/docs         architecture notes, runbooks, db/memory-layer/security design docs
  /knowledge  sample Knowledge Base source docs (HLD Sec 7.4), ingested by scripts/ingest-knowledge.ts
  /runbooks   operational procedures (backup/restore, ...)
/docker       Dockerfile (multi-stage), docker-compose.yml (gateway/worker/broadcast-worker/nginx/certbot/postgres/redis), nginx.conf.template (HTTPS-only, HSTS, ACME challenge)
/scripts      provision-gcp (GCP infra, HLD Sec 14), deploy, seed, backup, ingest-knowledge
```

**Status: scaffolding, with the database schema and Memory Layer now implemented.**

Real, working code (not stubs):

- **Database** — `src/db/schema.ts` (Drizzle ORM, all 10 tables including
  `knowledge_chunks`), its migrations (`src/db/migrations/*.sql`, including
  `CREATE EXTENSION vector`), the migration runner (`src/db/migrate.ts`),
  the seed script (`scripts/seed.ts`), and the Postgres adapter
  (`src/memory/postgresAdapter.ts`). See
  [`docs/db-schema.md`](docs/db-schema.md) for the table-by-table rationale.
- **Memory Layer** (HLD Sec 7.6, architecture diagram Sec 4) —
  `src/memory/conversationStore.ts` (Postgres-backed conversation history,
  20-message default window, Gemini prompt shaping),
  `src/memory/vectorStore.ts` (PGVector-default / Chroma-swappable Knowledge
  Base vector store, HLD Sec 7.4), `src/memory/embeddings.ts` (Gemini
  embedding wrapper), `src/memory/chunking.ts` (pure document chunker), and
  `src/memory/similarity.ts` (cosine similarity / top-k ranking). Ingested
  via `scripts/ingest-knowledge.ts` (`pnpm knowledge:ingest`) from
  `/docs/knowledge`. See [`docs/memory-layer.md`](docs/memory-layer.md) for
  the full design rationale.
- **WhatsApp Tool + webhook intake** (HLD Sec 7.3, and the webhook half of
  Sec 4/8) — `src/tools/whatsappTool.ts` (`receiveMessage` parsing,
  `sendMessage`/`replyMessage`, `broadcastMessage` with bounded concurrency,
  retry/backoff, and optional image/PDF attachments,
  `uploadImage`/`uploadPDF`/`downloadMedia`), `src/gateway/webhook.ts`
  (Fastify GET verification + signature-checked POST intake),
  `src/gateway/queue.ts` + `inboundWorker.ts` (BullMQ — webhook enqueues
  and responds immediately, a separate worker process does the actual
  work, keeping the <5s NFR); `src/gateway/broadcastQueue.ts` +
  `broadcastWorker.ts` is the analogous BullMQ pair for scheduled
  announcements (HLD Sec 6.1) — see
  [`docs/whatsapp-integration.md`](docs/whatsapp-integration.md) and
  [`docs/broadcast-management.md`](docs/broadcast-management.md).
- **OpenClaw Gateway** (HLD Sec 7.1, 8) — `src/gateway/index.ts`'s
  `createOpenClawGateway()` wires **session management**
  (`src/gateway/session.ts`, Redis, keyed by `phone_e164`, idle timeout +
  resume-on-next-message), **tool execution**
  (`src/gateway/toolRegistry.ts`, registering all six tools —
  `whatsappTool`, `knowledgeSearchTool`, `complaintTool`, `suggestionTool`,
  `broadcastTool`, `escalationTool`, all now real implementations, not
  stubs), **memory management** (the Memory Layer above), and **agent
  orchestration** (`src/gateway/orchestrator.ts`, `src/agent/intentRouter.ts`,
  `src/agent/gemini.ts`, `src/agent/systemPrompt.ts` — the full HLD Sec 8
  pipeline: [hard guardrail block] -> [mandatory escalation] -> Intent
  Detection -> Tool Selection -> Knowledge Search -> Gemini -> Response —
  with `src/agent/guardrails.ts` (forbidden-action detection + `audit_logs`
  writer) and `src/agent/escalation.ts` (the five mandatory triggers,
  delegating creation/notification to `src/modules/escalation.ts`) as the
  two guardrail stages that run before anything else). `src/gateway/inboundProcessor.ts` routes each event
  by which of the **two WhatsApp numbers** it arrived on (HLD Sec 4:
  `WHATSAPP_PHONE_NUMBER_ID` public AI number vs
  `WHATSAPP_SECRETARY_PHONE_NUMBER_ID` private Human Secretary number) to
  either the resident agent pipeline or a small secretary command grammar
  (`approve <ref>` / `ack`|`resolve <ref>` / `pending escalations` / draft).
  See [`docs/agent-orchestration.md`](docs/agent-orchestration.md).
- **FAQ Assistant** (HLD Sec 6.2) — `src/modules/faq.ts`, extracted out of
  `gateway/orchestrator.ts`'s `faq` branch: category-scoped knowledge search
  (`FAQ_KNOWLEDGE_CATEGORIES`) across the four categories HLD Sec 6.2 names,
  a Gemini answer grounded only in retrieved chunks past the confidence
  gate, escalation instead of an answer below it. See
  [`docs/agent-orchestration.md`](docs/agent-orchestration.md#faq-assistant-modulesfaqts).
- **Complaint Management** (HLD Sec 6.3, workflow Sec 11) —
  `src/modules/complaints.ts`, extracted out of `gateway/orchestrator.ts`'s
  `complaint` branch: `fileComplaint` (create -> notify the secretary ->
  confirm the ticket id to the resident) and `checkStatus` ("status of
  TCK-2026-0001", scoped to the requesting resident so tickets can't be
  enumerated by guessing ids). Ticket id generation
  (`TCK-{year}-{4-digit sequence}`) lives in `tools/complaintTool.ts`. See
  [`docs/complaint-management.md`](docs/complaint-management.md).
- **Suggestion Management** (HLD Sec 6.4) — `src/modules/suggestions.ts`,
  extracted out of `gateway/orchestrator.ts`'s `suggestion` branch:
  `submitSuggestion` (classify via Gemini constrained output — a
  `responseSchema` STRING `enum` of the four categories, so the API itself
  can only return one of them, never free text — falling back to
  `tools/suggestionTool.ts`'s keyword classifier if Gemini fails -> create
  -> acknowledge). See
  [`docs/suggestion-management.md`](docs/suggestion-management.md).
- **Broadcast Management** (HLD Sec 6.1, workflow Sec 9) —
  `src/modules/broadcast.ts`, extracted out of `gateway/orchestrator.ts`'s
  secretary-command handling: `draftAnnouncement` ("AI Improves Language"
  via Gemini, image/PDF attachment upload, a preview reply — never sends)
  and `approveAnnouncement` (the only path that can send — immediately, or
  `markApprovedForSchedule` + a BullMQ delayed job
  (`gateway/broadcastQueue.ts`/`broadcastWorker.ts`) when `scheduled_at` is
  in the future). Every send logs who approved/when/recipient count to
  `audit_logs` (`AuditLogWriter.logBroadcastSent`). See
  [`docs/broadcast-management.md`](docs/broadcast-management.md).
- **Escalation Engine** (HLD Sec 6.5, 16) — `src/modules/escalation.ts`,
  the consolidated sink for `agent/escalation.ts`'s
  `checkMandatoryEscalation`/`escalateUnknownAnswer`/`escalateForReason`
  (guardrail triggers, FAQ low confidence, forbidden-action blocks, the
  broadcast-attempt/generic-escalation intent remap) and
  `gateway/orchestrator.ts`'s `ack`/`resolve <ref>` and new
  `pending escalations` command: `categorizeEscalation` (five-category
  taxonomy — `financial_dispute`/`legal_matter`/`committee_decision`/`abuse`/`unknown_question`,
  a new `escalations.category` enum column), `escalate` (auto-links a
  ticket id found in the message, full-context secretary notification via
  `tools/escalationTool.ts`), `acknowledge`, `listOpenEscalations`. See
  [`docs/escalation-engine.md`](docs/escalation-engine.md).

All five of HLD Sec 6's functional modules are now implemented. Remaining
documented scope boundary: `tools/whatsappTool.ts`'s not-yet-used
media-download-into-a-reply path.

## 10. Security Baseline (HLD Section 15) — **implemented**

HTTPS only · Encrypted secrets · Role-based access · JWT authentication ·
Audit logs · Encrypted database · Daily backup · No resident data shared
with the LLM unnecessarily · Human approval required for sensitive actions.

Every item above is implemented — see [`docs/security.md`](docs/security.md)
for the full design, and [`docs/runbooks/backup-restore.md`](docs/runbooks/backup-restore.md)
for the backup pipeline and restore steps:

- **HTTPS only** — `docker/nginx.conf`: port 80 only redirects, never
  proxies; port 443 pins modern TLS + HSTS + security headers.
- **Encrypted secrets** — `config/secrets.ts` + `config/env.ts`'s
  `loadEnvAsync`: `SECRETS_SOURCE=gcp` resolves GEMINI_API_KEY,
  WHATSAPP_CLOUD_API_TOKEN, DATABASE_URL, JWT_SECRET, and
  FIELD_ENCRYPTION_KEY from GCP Secret Manager at every process boot.
  `.env` is local-dev/test only — **never commit real secrets in it**; see
  `.env.example`.
- **Role-based access + JWT authentication** —
  `gateway/adminAuth.ts`/`adminRoutes.ts`: `secretary` (full access) vs
  `read_only` (view only) roles, enforced on `/admin/*` (mounted only when
  `JWT_SECRET` is set).
- **Audit logs** — `agent/guardrails.ts`'s `AuditLogWriter`: every
  forbidden-action block, broadcast send, complaint/suggestion filing, and
  escalation create/acknowledge writes an `audit_logs` row (actor, action,
  timestamp).
- **Encrypted database** — `security/fieldEncryption.ts` +
  `tools/residentsTool.ts`: `residents.phone_e164`/`emergency_contact` are
  AES-256-GCM-encrypted at rest, with a deterministic blind-index hash
  column for the phone-number lookups that still need to work.
- **Daily backup** — `scripts/backup.sh`: `pg_dump` → `gzip` → `openssl
aes-256-cbc` → `gsutil cp`, 90-day retention.
- **No resident data shared with the LLM unnecessarily** —
  `agent/piiRedaction.ts`: no resident record is ever serialized into a
  Gemini prompt in the first place, and phone-number-shaped text is
  redacted from what's actually sent to the FAQ path specifically.
- **Human approval required for sensitive actions** — HLD Sec 16's
  guardrails/escalation system (Section 6 above), not repeated here.

## 11. Roadmap (HLD Section 18)

- **Phase 1**: Broadcast, FAQs, Complaints, Suggestions
- **Phase 2**: Visitor Management, Maintenance Tracking, Committee Dashboard, Analytics
- **Phase 3**: Voice Assistant, Multilingual Support, Image Understanding, Smart Notifications, Predictive Maintenance

## 12. Working Conventions for This Repo

- Node 20+, pnpm, strict TypeScript, ESM (`"type": "module"` — use `.js`
  extensions in relative imports even though source is `.ts`).
- Run `pnpm typecheck`, `pnpm lint`, and `pnpm test` before considering any
  change done.
- Never hardcode secrets — everything sensitive comes from environment
  variables validated by [`src/config/env.ts`](src/config/env.ts); see
  [`.env.example`](.env.example) for the full list and
  `SECRETS_SOURCE=gcp` for the Secret Manager path.
- When implementing a module, re-read the matching HLD section and the
  guardrails in Section 6 above first.
- `src/e2e/` — end-to-end HLD workflow tests (Sec 9, 10, 11) plus a
  Phase 3.2 guardrail regression suite (Sec 16), all real orchestrator/module
  wiring with only outer I/O faked. Re-run `pnpm test:coverage` and check
  [`docs/test-coverage.md`](docs/test-coverage.md) after touching
  `gateway/orchestrator.ts`, `agent/guardrails.ts`, or `agent/escalation.ts` —
  that doc also tracks which HLD Sec 15–17 requirements aren't covered by
  any test yet.
- **CI** — [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on
  every PR and every push to `main`/`develop`: lint + typecheck + full
  test suite with coverage (one job), the guardrail regression suite
  again as its own independently-visible job ("Safety Guardrails" — see
  the workflow's own header comment for why it's split out), and a
  Docker build check (no push).
- **CD** — [`.github/workflows/cd.yml`](.github/workflows/cd.yml) fires
  via `workflow_run` once CI passes on `main`: builds and pushes
  `docker/Dockerfile` to Artifact Registry (tags `latest` + short SHA) via
  `scripts/gcp/setup-cicd.sh`'s WIF auth (`docs/deployment.md`'s "CI/CD
  Auth" section) — no service account key. The `build-and-push` job sits
  behind a `production` GitHub Environment with a required reviewer
  (Section 2's human-in-the-loop principle, applied to the deploy
  pipeline itself, not just the app). Scope stops at "image pushed" —
  rolling it out to the VM (`scripts/gcp/remote-deploy.sh`, over IAP-
  tunneled SSH) is still a later phase.
