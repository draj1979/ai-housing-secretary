# WhatsApp Integration

Implements HLD Sec 7.3 (WhatsApp Tool) and the webhook half of Sec 4/8
(architecture diagram, Agent Workflow). Two pieces:

1. **`src/tools/whatsappTool.ts`** — everything that talks to the WhatsApp
   Cloud API: parsing inbound webhook payloads, sending/replying, broadcast,
   and media upload/download.
2. **`src/gateway/webhook.ts` + `queue.ts` + `inboundWorker.ts`** — the
   HTTPS entrypoint Meta calls, and the async pipeline that keeps it fast.

## 1. WhatsApp Tool (`whatsappTool.ts`)

### `receiveMessage(payload)` — parsing inbound events

Pure function (no I/O): validates the webhook payload shape with Zod (it's
untrusted network input) and flattens `entry[].changes[].value.messages[]`
across a batched delivery into a normalized `WhatsAppInboundEvent[]`:

| Event `type`  | Fields                                         | WhatsApp source                                                |
| ------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `text`        | `text`                                         | `messages[].text.body`                                         |
| `image`       | `mediaId`, `mimeType`, `caption?`              | `messages[].image`                                             |
| `document`    | `mediaId`, `mimeType`, `filename?`, `caption?` | `messages[].document`                                          |
| `reaction`    | `emoji`, `reactedToMessageId`                  | `messages[].reaction`                                          |
| `unsupported` | `rawType`                                      | any other type (location, sticker, contacts, interactive, ...) |

A status-only delivery (message delivered/read receipts, no `messages` key)
or a payload that doesn't parse as a webhook at all returns `[]` — that's
the normal case for most deliveries, not an error condition callers need to
handle specially.

Every event also carries `toPhoneNumberId` — the `phone_number_id` from the
payload's `metadata`, i.e. which of the society's two WhatsApp numbers
(public AI Secretary vs private Human Secretary, HLD Sec 4) the message
arrived on. `gateway/inboundProcessor.ts` uses this to route resident
messages and secretary commands differently — see
[`docs/agent-orchestration.md`](agent-orchestration.md).

Because it's pure and exported standalone (not just via the `WhatsAppTool`
interface), it's directly unit-tested against recorded fixture payloads —
see [`whatsappTool.test.ts`](../src/tools/whatsappTool.test.ts) and
[`__fixtures__/whatsapp/`](../src/tools/__fixtures__/whatsapp/) (text,
image, document/PDF, reaction, a status-only payload, and an unmodeled
`location` type).

### `sendMessage` / `replyMessage`

Both POST to `/{apiVersion}/{phoneNumberId}/messages`. `replyMessage` adds
`context: { message_id }`, which is how the Cloud API threads a reply to a
specific prior message.

### `broadcastMessage(recipients, text)`

The Cloud API has no native "send to a group/segment" call — a broadcast is
just sending to each recipient individually. `broadcastMessage` does that
with:

- **Bounded concurrency** (`WHATSAPP_BROADCAST_CONCURRENCY`, default 5) via
  a small inline worker-pool (`mapWithConcurrency`) — no need for a
  `p-limit`-style dependency for something this small.
- **Per-recipient isolation**: one recipient failing (bad number, opted
  out) doesn't abort the rest — failures land in `BroadcastResult.failed`
  instead of throwing.
- **`durationMs`** in the result, so callers/tests can check it against the
  <30s broadcast-time NFR (`config/constants.ts` `NFR_TARGETS.broadcastTimeSeconds`).

### Retry / backoff (`requestWithRetry`)

Every outbound Cloud API call (send, upload, the media-metadata lookup) goes
through one retry wrapper:

- Retries on **429** (rate limited) and **5xx**, and on network errors
  (`fetch` throwing). Does **not** retry other 4xx (bad request, auth
  failure, invalid number) — those won't succeed on retry.
- Honors Meta's **`Retry-After`** header when present; otherwise waits
  `retryBaseDelayMs * 2^attempt` plus random jitter
  (`WHATSAPP_RETRY_BASE_DELAY_MS`, `WHATSAPP_MAX_RETRIES`).
- Exhausting retries (or a non-retryable failure) raises `WhatsAppApiError`
  (carries the HTTP status and response body for callers/logs).
- `sleepImpl` is injectable so tests exercise many retries without real
  wall-clock delay — see `whatsappTool.test.ts`'s "retry / backoff" suite.

### `uploadImage` / `uploadPDF` / `downloadMedia`

Upload accepts either `filePath` or an in-memory `buffer` + `filename`
(mime type inferred from the extension if not given), POSTs multipart form
data to `/{phoneNumberId}/media`. Download is Meta's documented two-step
flow: GET the media id to get a short-lived authenticated URL, then GET
that URL for the bytes.

### Testability: explicit config, no hidden env reads

`createWhatsAppTool(config)` takes an explicit `WhatsAppToolConfig` —
`fetchImpl` and `sleepImpl` are injectable, so the entire test suite runs
with zero real network calls and zero real timers.
`whatsappToolConfigFromEnv(env)` is the _only_ place this module reads env,
used by the real gateway wiring, not by the tool itself.

## 2. Webhook (`gateway/webhook.ts`)

```
Meta → HTTPS POST /webhook → [signature check] → enqueue (Redis) → 200 OK
                                                        ↓
                                    gateway/inboundWorker.ts (separate process)
                                                        ↓
                                    gateway/inboundProcessor.ts
                                    (normalize → conversation memory → onEvent hook)
```

### GET — subscription verification

Meta's handshake: `hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`.
`verifyChallenge` (pure) checks mode + token match `WHATSAPP_VERIFY_TOKEN`
and echoes `hub.challenge` back as plain text on success, `403` otherwise.

### POST — signature verification, then enqueue

1. **Raw body capture.** Fastify's default JSON parser would parse-then-discard
   the exact bytes; signature verification needs those exact bytes, so a
   custom content-type parser captures the raw `Buffer` (documented Fastify
   pattern for this exact problem) and the route parses JSON itself only
   _after_ the signature check passes.
2. **`verifySignature`** (pure): HMAC-SHA256 of the raw body with
   `WHATSAPP_APP_SECRET`, hex-encoded, compared to the `X-Hub-Signature-256`
   header (`sha256=<hex>`) with `crypto.timingSafeEqual`. A missing/invalid
   header → `401`, nothing enqueued.
3. **Enqueue and respond.** `await deps.enqueue(payload)` (a single local
   Redis round trip via BullMQ, `gateway/queue.ts`) then `200 { status:
"received" }`. Nothing else runs synchronously after that — see
   `webhook.test.ts`'s "responds only once enqueue resolves" test, which
   proves the response is gated on exactly that one call and nothing more.
   If enqueueing itself fails, the route returns `500` (not silently `200`)
   so Meta retries the delivery instead of the event being lost.

`registerWebhookRoutes(app, deps)` takes `WebhookDeps` — an injectable
`enqueue` function, not a concrete BullMQ `Queue` — so the whole route
(challenge verification, signature validation, JSON parsing, response
codes) is integration-tested via Fastify's `.inject()` with zero real Redis,
using the same recorded fixture payloads as the tool tests. See
[`webhook.test.ts`](../src/gateway/webhook.test.ts).
`createWebhookDepsFromEnv(env)` builds the real, BullMQ-backed deps for
`gateway/index.ts`.

## 3. Async processing (`queue.ts`, `inboundWorker.ts`, `inboundProcessor.ts`)

- **`queue.ts`** — a BullMQ `Queue` (`whatsapp-inbound`) the webhook pushes
  `{ payload, receivedAt }` onto. `attempts: 3` with exponential backoff at
  the queue level too, separate from (and in addition to) the WhatsApp
  tool's own outbound retry logic — this covers a worker restart or
  transient Redis blip, not Cloud API rate limits.
- **`inboundWorker.ts`** — a BullMQ `Worker` consuming that queue,
  concurrency `INBOUND_QUEUE_CONCURRENCY` (default 5), run as its **own
  process** (`pnpm worker` / `pnpm dev:worker`, and its own service in
  `docker/docker-compose.yml`) — separate from the HTTP server so the two
  scale and restart independently, a standard split for a queue consumer
  behind a webhook.
- **`inboundProcessor.ts`** — `processInboundWebhookPayload(payload, deps)`,
  the actual "hand off to the OpenClaw Gateway" step (HLD Sec 8):
  normalizes via `receiveMessage`, resolves the resident by phone
  (`residents.phone_e164`, prefixing WhatsApp's digits-only `from` with
  `+`), and appends to conversation memory
  (`memory/conversationStore.ts`) — even for non-text events, rendered as
  readable history text (`[image] caption`, `[document] filename`,
  `[reacted 👍 to message ...]`) so a human reviewing the thread later can
  follow it. Messages from a phone number with no matching `residents` row
  are logged and skipped, not persisted or thrown on — deciding what to do
  about an unknown sender is a future module's call, not this layer's.

Also routes by `toPhoneNumberId` (above) — an event on the Secretary's
number skips resident lookup and this memory write entirely and goes to a
separate `onSecretaryEvent` hook instead. `processInboundWebhookPayload`
calls `onEvent`/`onSecretaryEvent` after persisting each resident event —
`gateway/inboundWorker.ts` wires both to `gateway/orchestrator.ts`'s
`handleResidentEvent`/`handleSecretaryEvent`, the HLD Sec 8 Agent Workflow
(Intent Detection -> Tool Selection -> Knowledge Search -> Gemini ->
Response) and the secretary command handling — see
[`docs/agent-orchestration.md`](agent-orchestration.md) for the full
design. (Earlier in this project these hooks defaulted to a no-op log
stub; they're now wired to real orchestration.)

## Why this design keeps the <5s NFR (HLD Sec 17)

The webhook route's only await after signature verification is the enqueue
call — a local Redis write, not the Gemini call, database writes for
conversation memory, or the full agent orchestration pipeline
(`gateway/orchestrator.ts`). All of that runs in `inboundWorker.ts`, a
separate process, after the webhook has already responded.
`webhook.test.ts` has a test that specifically proves the HTTP response
cannot resolve before `enqueue` does, and nothing else — the architectural
guarantee this NFR depends on.

## Verified live (this session, not part of `pnpm test`)

A throwaway Redis + pgvector/Postgres pair was started via Docker, migrated
and seeded, then the real Fastify webhook + real BullMQ queue + real
`inboundWorker.ts` were run end-to-end: GET verification returned the
challenge, a signed POST of the `text-message.json` fixture returned `200`
immediately, the worker picked up the job, looked up the seeded resident by
phone, created a `conversations` row, and wrote the message with the
correct body and `senderType: 'resident'` — all matching what the mocked
unit/integration tests assert. Both scratch containers were removed
afterward, and the repo's own `docker/docker-compose.yml` stack was not
touched.
