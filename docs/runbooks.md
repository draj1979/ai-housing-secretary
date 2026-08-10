# Runbooks

Placeholder operational runbooks. To be filled in as modules are implemented.

## Deploy

See [`../scripts/deploy.sh`](../scripts/deploy.sh) (not yet implemented).

## Database migration

```bash
pnpm db:generate   # generate Drizzle migration from src/db/schema.ts
pnpm db:migrate    # apply pending migrations (DATABASE_URL)
```

## Backup / restore

Daily backup via [`../scripts/backup.sh`](../scripts/backup.sh) (not yet
implemented) — targets the `<30s>`... see NFR `databaseBackupIntervalHours`
in `src/config/constants.ts`.

## Running the gateway + worker locally

The HTTP webhook (`gateway/index.ts`) and the queue consumer
(`gateway/inboundWorker.ts`) are separate processes — see
[`docs/whatsapp-integration.md`](whatsapp-integration.md).

```bash
pnpm dev          # HTTP server (webhook intake) on PORT
pnpm dev:worker   # BullMQ worker (processes queued inbound events)
```

Both need `DATABASE_URL` and `REDIS_URL` reachable; the worker also needs
Postgres for the resident lookup + conversation memory writes. In
production these are `docker/docker-compose.yml`'s `gateway` and `worker`
services.

## Incident: WhatsApp webhook not receiving events

1. Check `WHATSAPP_VERIFY_TOKEN` matches the Meta App Dashboard subscription
   — a GET to `/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
   should echo the challenge back with `200`; a token mismatch returns `403`.
2. Check Nginx is proxying `/webhook` to the gateway container (`docker/nginx.conf`).
3. A `401` on POST means signature verification failed — confirm
   `WHATSAPP_APP_SECRET` matches the Meta App Dashboard's App Secret exactly
   (not the Cloud API access token).
4. A `200` response but no visible effect means the event reached the
   queue but the **worker** isn't running or can't reach Redis/Postgres —
   check `pnpm dev:worker` / the `worker` container's logs, not the
   gateway's.
5. Check Cloud Logging for gateway/worker errors (GCP Cloud Logging, Sec 14).

## Incident: Escalation not reaching secretary

1. Confirm `WHATSAPP_SECRETARY_NUMBER` is set correctly.
2. Check `src/agent/guardrails.ts` escalation trigger detection logs.
3. Verify the secretary's WhatsApp number has not blocked the AI number.
