# Test Coverage & HLD Requirement Traceability

`pnpm test` — 370 tests, 33 files, all passing. Coverage below is from
`vitest run --coverage` (v8 provider); see "Reading these numbers" for why
raw % isn't the right way to judge this codebase's test posture on its
own.

## New: end-to-end workflow tests (`src/e2e/`)

Four suites, each going through the _real_ `gateway/orchestrator.ts` +
real `modules/*.ts` wiring — only the outermost I/O (WhatsApp, DB-backed
tools, Gemini) is faked, via a shared builder
([`src/e2e/testHarness.ts`](../src/e2e/testHarness.ts)) that constructs a
fully-wired orchestrator the same way `gateway/orchestrator.test.ts`'s own
`makeDeps()` does. What makes these "end-to-end" rather than duplicating
the existing per-module unit tests: they assert on the _whole_ request
lifecycle in one flowing scenario, including response-time budgets that
only mean something once realistic I/O latency is simulated.

| File                                                                | HLD section                 | What it proves beyond the unit tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`residentQuery.e2e.test.ts`](../src/e2e/residentQuery.e2e.test.ts) | Sec 10 (Resident Query)     | Grounding holds end-to-end (exact retrieved chunks reach Gemini, unmodified); a low-confidence or empty match escalates _instead of_ calling Gemini; the whole tag→search→Gemini→reply round trip stays inside the `NFR_TARGETS.averageResponseSeconds` (5s) budget with realistic (150ms search + 1.8s Gemini) latency.                                                                                                                                                                                                          |
| [`complaint.e2e.test.ts`](../src/e2e/complaint.e2e.test.ts)         | Sec 11 (Complaint Workflow) | The full create→notify→confirm chain in one test (not three separate module-boundary assertions); ownership-scoped status checks; the complaint is still recorded even if the secretary notification fails; the round trip stays inside the 5s response NFR too.                                                                                                                                                                                                                                                                  |
| [`broadcast.e2e.test.ts`](../src/e2e/broadcast.e2e.test.ts)         | Sec 9 (Broadcast Workflow)  | Draft→AI-improve→preview never sends (asserted by checking the real `whatsapp.broadcastMessage` was never called during drafting); only explicit `"approve <ref>"` sends; delivery to `NFR_TARGETS.minResidentCapacity` (1000) residents stays inside the `broadcastTimeSeconds` (30s) budget — using the _real_ concurrency-limited `whatsapp.broadcastMessage` fan-out (fake `fetch`, real `mapWithConcurrency`), not a mocked send. See "Flagged finding" below — this file also demonstrates where that budget stops holding. |
| [`guardrails.e2e.test.ts`](../src/e2e/guardrails.e2e.test.ts)       | Sec 16 (Phase 3.2)          | Every one of the six `AI_FORBIDDEN_ACTIONS` and four text-pattern `ESCALATION_TRIGGERS`, 2–3 phrasings each (43 tests total) — blocked/escalated, audit-logged, never reaching a tool or Gemini — plus precedence (a message matching both a forbidden-action and an escalation-trigger pattern is blocked, not merely escalated) and negative cases (ordinary complaint/suggestion/FAQ messages are never false-positived). Two `it()`s assert the phrase tables themselves can't silently shrink below the full six/four.       |

## Flagged finding: default broadcast concurrency doesn't guarantee the 30s NFR at scale

`broadcast.e2e.test.ts` demonstrates, not just asserts, a real
configuration gap: at `WHATSAPP_BROADCAST_CONCURRENCY`'s default of 5,
1000 recipients complete within 30s only while per-message WhatsApp Cloud
API latency stays under roughly 150ms. The suite includes a passing test
at 100ms (comfortably inside budget, ~20s) and a passing test at 300ms
that explicitly asserts the budget is **exceeded** (~60s) at the default
concurrency — then a third test showing `WHATSAPP_BROADCAST_CONCURRENCY=20`
restores the budget at that same 300ms latency. **Recommendation**: a
society near the 1000-resident ceiling should raise
`WHATSAPP_BROADCAST_CONCURRENCY` above the default 5, or measure real
Meta API latency from the deployment region before relying on the default
meeting HLD Sec 17's 30s target. Not a code bug — `mapWithConcurrency`
does exactly what it's configured to — but a deployment-time tuning
decision this suite makes visible instead of silent.

## Reading these numbers: two different testing strategies, on purpose

```
All files          |   61.71 |    87.18 |   67.28 |   61.71 |
```

The low overall statement/line % is concentrated entirely in files this
repo has _never_ unit-tested, by a consistent, documented design choice
made across every implementation phase (see each `docs/*.md`'s own
"Verified live" section): DB/network-touching code is exercised against
real Postgres/Redis via throwaway `scripts/_verify-*.ts` scripts during
development, not mocked-drizzle unit tests — a mocked Drizzle query
builder mostly tests the mock, not the SQL. Pure logic and DI-boundary
orchestration get real `pnpm test` coverage instead.

| Near-zero coverage                                                                                                   | Why, and where it's actually verified                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/*Tool.ts` (`escalationTool`, `residentsTool`, `knowledgeSearchTool`, most of `complaintTool`/`broadcastTool`) | Direct Drizzle DB reads/writes. Live-verified against real Postgres in each feature's own session (see `docs/escalation-engine.md`, `docs/security.md`, `docs/broadcast-management.md`, etc.'s "Verified live" sections).                                                                   |
| `memory/postgresAdapter.ts`, `conversationStore.ts`, `embeddings.ts`, `vectorStore.ts`                               | Same — real Postgres/pgvector/Gemini embeddings, live-verified per `docs/memory-layer.md`.                                                                                                                                                                                                  |
| `gateway/index.ts`, `inboundWorker.ts`, `broadcastWorker.ts`, `queue.ts`, `broadcastQueue.ts`                        | Composition roots and BullMQ workers — real Redis/Postgres, live-verified via a full `docker compose up` (`docs/deployment.md`'s "Verified live" sections) and dedicated throwaway scripts for the queue/scheduling behavior specifically.                                                  |
| `db/migrate.ts`, `scripts/*.ts`                                                                                      | CLI entry points, run for real against scratch Postgres in every phase's live verification, not under vitest.                                                                                                                                                                               |
| `agent/guardrails.ts` (57.4%)                                                                                        | The uncovered lines (160-212) are `createAuditLogWriter`'s DB-writing implementation — same DB-touching-code convention as above; `detectForbiddenActionRequest`/`detectEscalationTrigger` (the actual guardrail logic) are 100% covered, including by this session's new regression suite. |

Modules with **actual application logic** — `modules/*.ts`,
`agent/intentRouter.ts`, `agent/piiRedaction.ts`, `agent/escalation.ts`,
`security/fieldEncryption.ts`, `gateway/orchestrator.ts`,
`gateway/health.ts`, `gateway/adminAuth.ts`/`adminRoutes.ts` — sit at
88–100% statement coverage, which is the number that actually matters
here.

## HLD Sec 15–17 requirements: coverage status

| Requirement                                                  | Status                                                    | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sec 15: HTTPS only                                           | ⚠️ Not unit-testable                                      | Nginx config, not application code — verified live via `docker compose up` + `curl` in `docs/deployment.md`, not `pnpm test`.                                                                                                                                                                                                                                                                                                                                                        |
| Sec 15: Encrypted secrets                                    | ✅ Tested                                                 | `src/config/secrets.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Sec 15: Role-based access / JWT authentication               | ✅ Tested                                                 | `src/gateway/adminAuth.test.ts`, `adminRoutes.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Sec 15: Audit logs                                           | ✅ Tested                                                 | `src/agent/guardrails.test.ts`, per-module tests, and this session's `guardrails.e2e.test.ts` (audit_logs call assertions on every forbidden-action case)                                                                                                                                                                                                                                                                                                                            |
| Sec 15: Encrypted database (field-level)                     | ✅ Tested (crypto logic); ⚠️ DB wiring live-verified only | `src/security/fieldEncryption.test.ts` (100%); `tools/residentsTool.ts`'s actual DB reads/writes are 0% under vitest, live-verified per `docs/security.md`                                                                                                                                                                                                                                                                                                                           |
| Sec 15: Daily backup                                         | ⚠️ Not unit-testable                                      | Bash script (`scripts/backup.sh`), not TypeScript — no `pnpm test` coverage possible; the encrypt/decrypt/restore pipeline was verified live once (`docs/runbooks/backup-restore.md`) but **has no automated regression test** — a future change to that script could silently break the pipeline with nothing catching it. **Flagged as a real gap.**                                                                                                                               |
| Sec 15: No resident data shared with the LLM unnecessarily   | ✅ Tested                                                 | `src/agent/piiRedaction.test.ts`, `src/agent/gemini.test.ts`, and this session's `residentQuery.e2e.test.ts` (grounding assertions)                                                                                                                                                                                                                                                                                                                                                  |
| Sec 15: Human approval for sensitive actions                 | ✅ Tested                                                 | This session's `guardrails.e2e.test.ts` + `broadcast.e2e.test.ts` (draft never sends without approval)                                                                                                                                                                                                                                                                                                                                                                               |
| Sec 16: Forbidden actions / mandatory escalation (Phase 3.2) | ✅ Tested, comprehensively                                | This session's `guardrails.e2e.test.ts` — see above                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Sec 17: `averageResponseSeconds` (5s)                        | ✅ Tested                                                 | `residentQuery.e2e.test.ts`, `complaint.e2e.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sec 17: `broadcastTimeSeconds` (30s)                         | ✅ Tested, with a flagged finding                         | `broadcast.e2e.test.ts` — see "Flagged finding" above                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Sec 17: `minResidentCapacity` (1000)                         | ✅ Exercised                                              | `broadcast.e2e.test.ts` runs the fan-out at exactly this scale                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Sec 17: `concurrentUsers` (500)                              | ❌ **Not covered**                                        | No test exercises 500 _simultaneous_ resident conversations (session store contention, BullMQ `INBOUND_QUEUE_CONCURRENCY` under concurrent load). `gateway/session.ts`'s Redis-backed store and `inboundWorker.ts`'s BullMQ concurrency are individually reasonable, but nothing proves the combination holds at 500 concurrent users. **Flagged as a real gap** — a load test (e.g. k6 or autocannon against a real running stack) would be the right tool, not a vitest unit test. |
| Sec 17: `availabilityPercent` (99.9%)                        | N/A — infra concern                                       | Not testable at the application-code layer; addressed by deployment redundancy/healthchecks (`docs/deployment.md`'s `/health`, `/health/ready`, restart policies), not something a test asserts directly.                                                                                                                                                                                                                                                                            |
| Sec 17: `databaseBackupIntervalHours` (24)                   | ⚠️ Config only                                            | `BACKUP_SCHEDULE_CRON` defaults to `0 2 * * *` (`config/env.ts`) but has no explicit test asserting that default; the actual 24-hour cadence depends on the cron/Cloud Scheduler trigger being configured correctly on the VM (`docs/deployment.md`), which is outside this repo's own test boundary.                                                                                                                                                                                |
| Sec 17: `logRetentionDays` (90)                              | ⚠️ Partially implemented                                  | `config/env.test.ts` asserts the default (90); `scripts/provision-gcp.sh`'s backups bucket has a matching 90-day GCS lifecycle rule. **But there is no pruning of the `audit_logs` Postgres table itself** — rows accumulate indefinitely; only backup _files_ expire. **Flagged as a real implementation gap**, not just a test gap — nothing in this codebase enforces `logRetentionDays` against the live `audit_logs` table.                                                     |

## Running coverage locally

```bash
pnpm test:coverage
```

(`@vitest/coverage-v8` is already a devDependency, pinned to vitest's own
2.x line — not the latest 4.x, which requires vitest 4.)

HTML report at `coverage/index.html` (vitest.config.ts's `coverage.reporter`
includes `html`); the summary table above is from the `text` reporter.
