# Architecture Notes

This is a working-notes companion to the root [`CLAUDE.md`](../CLAUDE.md), which
is the source of truth. See the original HLD at `../../Openclaw1 HLD.md`.

## Layers

1. **Residents** interact via WhatsApp with the public AI Secretary number;
   the Secretary uses a separate, private number for approvals/escalations
   (HLD Sec 4 — both numbers deliver to the same webhook, distinguished by
   `phone_number_id`; see [`docs/agent-orchestration.md`](agent-orchestration.md)).
2. **WhatsApp Cloud API** delivers inbound messages via HTTPS webhook and
   accepts outbound sends/broadcasts.
3. **OpenClaw Gateway** (`src/gateway`) — session management, tool
   execution, memory management, agent orchestration, all implemented. Runs
   on a GCP Compute Engine VM behind Nginx, split across two processes: the
   HTTP webhook receiver (`gateway/index.ts`) and the queue-consuming
   worker that does the actual work (`gateway/inboundWorker.ts`) — see
   [`docs/whatsapp-integration.md`](whatsapp-integration.md) for why, and
   [`docs/agent-orchestration.md`](agent-orchestration.md) for the
   session/tool-registry/orchestrator wiring.
4. **Agent layer** (`src/agent`) — system prompt, guardrails (forbidden
   actions + escalation-trigger detection), keyword-based intent routing,
   and the Gemini response wrapper. Implemented.
5. **Tool layer** (`src/tools`) — WhatsApp, knowledge search, complaint,
   suggestion, broadcast, and escalation tools. All implemented and
   registered in `gateway/toolRegistry.ts`.
6. **Memory layer** (`src/memory`) — conversation memory backed by
   PostgreSQL, and knowledge-base embeddings backed by a vector store
   (ChromaDB or PGVector). Implemented.
7. **Gemini** (Flash Lite) is the LLM used for FAQ response generation
   (`agent/gemini.ts`) — only called once a knowledge-search match clears
   the confidence gate (`config/constants.ts` `FAQ_MIN_CONFIDENCE_SCORE`),
   the "never hallucinate" guardrail's concrete mechanism.
8. **Security baseline** (HLD Sec 15) — HTTPS-only Nginx, GCP Secret
   Manager-sourced secrets, JWT + role-based admin endpoints, audit
   logging, field-level encryption of resident PII at rest, LLM PII
   redaction, and encrypted daily backups. All implemented — see
   [`docs/security.md`](security.md).
9. **Deployment layer** (HLD Sec 13) — `/docker`'s multi-stage Dockerfile
   (one image, three processes: `gateway`, `worker`, `broadcast-worker`),
   `docker-compose.yml` (adds `nginx` + `certbot` for TLS, `postgres`,
   `redis`, optional `chroma`), and `nginx.conf.template` (HTTPS
   termination, ACME challenge, webhook/admin/health path allowlist). All
   implemented and verified live (a full `docker compose up` with every
   healthcheck passing) — see [`docs/deployment.md`](deployment.md) for
   the fresh-VM walkthrough.
10. **GCP infrastructure** (HLD Sec 14) — `scripts/provision-gcp.sh`: one
    documented, idempotent-per-function `gcloud` script provisioning
    Compute Engine, Static IP, Firewall (80/443 only), Secret Manager,
    Cloud Storage (society documents + backups), and — opt-in via
    `PROVISION_DNS`/`PROVISION_CLOUD_SQL` — Cloud DNS and Cloud SQL as an
    alternative to `docker-compose.yml`'s self-hosted `postgres`. Cloud
    Monitoring/Logging is the Ops Agent (VM metrics/system logs, installed
    by the VM's startup script) plus Docker's `gcplogs` driver (per-container
    gateway/worker logs) — see [`docs/deployment.md`](deployment.md)'s
    "Cloud Monitoring & Logging" section. Implemented; not executed against
    a real project this session (creating billable cloud resources needs
    explicit authorization — see that doc).
11. **End-to-end workflow tests** (`src/e2e/`) — HLD Sec 9 (Broadcast), Sec
    10 (Resident Query), Sec 11 (Complaint) each get a real
    orchestrator-wired test asserting on the whole request lifecycle,
    including the Sec 17 response-time/broadcast-time NFR budgets with
    simulated realistic latency; plus a 43-test Phase 3.2 guardrail
    regression suite (`guardrails.e2e.test.ts`, HLD Sec 16). See
    [`docs/test-coverage.md`](test-coverage.md) for coverage numbers and
    every HLD Sec 15–17 requirement's test status, including the ones
    flagged as gaps.

## Module boundaries

`src/modules/faq.ts`, `src/modules/complaints.ts`,
`src/modules/suggestions.ts`, `src/modules/broadcast.ts`, and
`src/modules/escalation.ts` are implemented — the FAQ Assistant (HLD Sec
6.2), Complaint Management (HLD Sec 6.3, 11), Suggestion Management (HLD
Sec 6.4), Broadcast Management (HLD Sec 6.1, 9), and the Escalation Engine
(HLD Sec 6.5, 16), used by `gateway/orchestrator.ts`'s `faq`, `complaint`,
`suggestion` intent branches, secretary-command handling, and (via
`agent/escalation.ts`) every mandatory-escalation/forbidden-action trigger
respectively. See
[`docs/agent-orchestration.md`](agent-orchestration.md#faq-assistant-modulesfaqts),
[`docs/complaint-management.md`](complaint-management.md),
[`docs/suggestion-management.md`](suggestion-management.md),
[`docs/broadcast-management.md`](broadcast-management.md), and
[`docs/escalation-engine.md`](escalation-engine.md).

All five of HLD Sec 6's functional modules are now implemented — no
`src/modules/` scaffolding remains.

The **database schema**, the **memory layer**, the **WhatsApp tool +
webhook intake**, the **OpenClaw Gateway** (session/tools/memory/agent
orchestration), and all five functional modules are implemented — see
[`docs/db-schema.md`](db-schema.md), [`docs/memory-layer.md`](memory-layer.md),
[`docs/whatsapp-integration.md`](whatsapp-integration.md),
[`docs/agent-orchestration.md`](agent-orchestration.md),
[`docs/complaint-management.md`](complaint-management.md),
[`docs/suggestion-management.md`](suggestion-management.md),
[`docs/broadcast-management.md`](broadcast-management.md), and
[`docs/escalation-engine.md`](escalation-engine.md).

## Open questions / TODO before further implementation

- Confirm OpenClaw's native session/tool primitives so `src/gateway` wraps
  rather than reimplements them — `gateway/session.ts` and
  `gateway/toolRegistry.ts` are a reasonable from-scratch implementation of
  what HLD Sec 7.1 asks for, but if OpenClaw (the platform this app is
  "built on" per the HLD) has its own session/tool-registry primitives,
  these should delegate to those instead of standing alone.
- `modules/faq.ts`'s `FAQ_KNOWLEDGE_CATEGORIES` scopes the FAQ Assistant to
  four of the six knowledge-base categories (excluding Emergency Contacts
  and the Society Handbook) per a literal reading of HLD Sec 6.2's list —
  flagged in that file's doc comment as an interpretation worth revisiting
  if it proves too narrow in practice.
- HLD Sec 9's "AI Improves Language" step is now implemented —
  `modules/broadcast.ts`'s `createLanguageImprover` — see
  [`docs/broadcast-management.md`](broadcast-management.md).
- `agent/intentRouter.ts` and `tools/suggestionTool.ts`'s categorizer are
  both small deterministic keyword classifiers rather than Gemini calls —
  intentional (fast, free, testable without an API key), but a future
  iteration could swap in Gemini function-calling for higher accuracy if
  the keyword approach proves too coarse in practice.
- Intent detection currently only looks at the message text/caption of a
  single inbound event — it doesn't use conversation history to disambiguate
  a short follow-up message (e.g. "yes" after a clarifying question). The
  FAQ path does inject history into Gemini; complaint/suggestion/escalation
  classification does not.
