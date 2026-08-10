# AI Housing Society Secretary Assistant

An AI-powered virtual secretary for housing societies, built on the
**OpenClaw Agent Platform**. Residents interact entirely over **WhatsApp**;
the assistant answers FAQs grounded in society documents (via Gemini),
logs complaints and suggestions, broadcasts announcements, and escalates
anything sensitive to a human secretary — see the
[Human-in-the-Loop principle](CLAUDE.md#2-human-in-the-loop-principle) for
why escalation and guardrails are central to the design, not an
afterthought.

- **Design source of truth:** [`CLAUDE.md`](CLAUDE.md) — derived from, and
  kept in sync with, the original High Level Design at
  [`../Openclaw1 HLD.md`](../Openclaw1%20HLD.md). If you're new to this
  repo, read `CLAUDE.md` first.
- **Architecture working notes:** [`docs/architecture.md`](docs/architecture.md)
- **Test coverage & HLD requirement traceability:** [`docs/test-coverage.md`](docs/test-coverage.md)

## What's implemented

Everything in the HLD is implemented: WhatsApp webhook intake, session/
memory/tool-registry gateway, agent guardrails + intent routing, Gemini-
backed FAQ answering, complaint/suggestion/broadcast/escalation modules,
field-level PII encryption, JWT-protected admin endpoints, audit logging,
Docker/Compose deployment, and a GCP provisioning script. See
[`docs/architecture.md`](docs/architecture.md) for the full layer-by-layer
breakdown and links to each subsystem's own doc under [`docs/`](docs).

## Local development

Prerequisites: Node.js >= 20, [pnpm](https://pnpm.io) >= 9, Docker (for
Postgres/Redis, and optionally Chroma).

```bash
pnpm install
cp .env.example .env
# fill in .env: at minimum a Gemini API key and WhatsApp Cloud API
# credentials if you want to exercise those paths; sensible local
# defaults are already set for DATABASE_URL/REDIS_URL/etc.
```

Bring up Postgres + Redis (and run migrations) via Docker Compose:

```bash
cd docker
docker compose --env-file ../.env -f docker-compose.yml up -d postgres redis
cd ..
pnpm db:migrate
pnpm db:seed          # optional: seed sample residents/society data
```

Run the app locally (outside Docker, against the Dockerized Postgres/Redis):

```bash
pnpm dev               # gateway (webhook receiver), tsx watch
pnpm dev:worker        # inbound queue worker, separate process
pnpm dev:broadcast-worker  # broadcast queue worker, separate process
```

Or run the full stack (gateway + workers + nginx + postgres + redis) in
Docker — see [`docs/deployment.md`](docs/deployment.md) for the complete
walkthrough including TLS bootstrap.

### Checks

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test              # vitest, no infra required
pnpm test:coverage      # same, with coverage report
```

DB/network-touching code (migrations, backups, vector store, WhatsApp
sends) is verified separately against real Docker Postgres/Redis via
throwaway `scripts/_verify-*.ts` scripts per the two-tier testing
convention documented in `CLAUDE.md` — not part of `pnpm test`.

## Deployment

Production deployment targets a single GCP Compute Engine VM running the
full Docker Compose stack (Nginx TLS termination → Gateway + workers →
Postgres + Redis), provisioned by `scripts/provision-gcp.sh`. Full
walkthrough, from a fresh VM through first migration and health checks:
see [`docs/deployment.md`](docs/deployment.md).

## Documentation index

See [`docs/`](docs) for per-subsystem docs (agent orchestration, WhatsApp
integration, DB schema, memory layer, complaint/suggestion/broadcast/
escalation modules, security, deployment, and backup/restore runbooks).
`CLAUDE.md` §12 has a full "Working Conventions" map of the codebase.
