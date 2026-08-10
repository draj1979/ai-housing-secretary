/**
 * tools/whatsappTool.ts
 *
 * WhatsApp Cloud API tool (HLD Sec 7.3). Capabilities:
 *   - receiveMessage — parse incoming webhook payloads (text, image,
 *     document/PDF, reactions) into a normalized event list
 *   - sendMessage / replyMessage — send text, threaded via `context` where
 *     the Cloud API supports it
 *   - broadcastMessage — fan out to many resident numbers with bounded
 *     concurrency and retry/backoff on rate limits; text and/or already
 *     -uploaded image/document attachments (HLD Sec 6.1, 9)
 *   - uploadImage / uploadPDF / downloadMedia — wrap the Cloud API media
 *     endpoints
 *
 * Deliberately takes an explicit `WhatsAppToolConfig` rather than reading
 * `process.env` itself (see `whatsappToolConfigFromEnv` for the one place
 * that does) — keeps this module trivially testable and keeps env coupling
 * at the edge, in gateway/index.ts and gateway/inboundWorker.ts.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Inbound event types (receiveMessage)
// ---------------------------------------------------------------------------

interface InboundBase {
  messageId: string;
  from: string;
  timestamp: Date;
  contactName?: string;
  /**
   * The `phone_number_id` of the WhatsApp Business number this message
   * arrived on (HLD Sec 4: the society runs two numbers — the public AI
   * Secretary number and the private Human Secretary number — under one
   * WABA, both delivering to this same webhook). `undefined` if the payload
   * didn't include `metadata.phone_number_id`. See
   * gateway/inboundProcessor.ts for how this drives routing.
   */
  toPhoneNumberId?: string;
}

export interface TextInboundEvent extends InboundBase {
  type: 'text';
  text: string;
}

export interface ImageInboundEvent extends InboundBase {
  type: 'image';
  mediaId: string;
  mimeType: string;
  caption?: string;
}

export interface DocumentInboundEvent extends InboundBase {
  type: 'document';
  mediaId: string;
  mimeType: string;
  filename?: string;
  caption?: string;
}

export interface ReactionInboundEvent extends InboundBase {
  type: 'reaction';
  emoji: string;
  reactedToMessageId: string;
}

/** Any message type WhatsApp sends that we don't have a dedicated case for (location, contacts, sticker, interactive, ...). */
export interface UnsupportedInboundEvent extends InboundBase {
  type: 'unsupported';
  rawType: string;
}

export type WhatsAppInboundEvent =
  | TextInboundEvent
  | ImageInboundEvent
  | DocumentInboundEvent
  | ReactionInboundEvent
  | UnsupportedInboundEvent;

// ---------------------------------------------------------------------------
// Webhook payload schema (defensive — this is untrusted network input)
// ---------------------------------------------------------------------------

const mediaObjectSchema = z.object({
  id: z.string(),
  mime_type: z.string(),
  sha256: z.string().optional(),
  caption: z.string().optional(),
});

const textMessageSchema = z.object({
  type: z.literal('text'),
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  text: z.object({ body: z.string() }),
});

const imageMessageSchema = z.object({
  type: z.literal('image'),
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  image: mediaObjectSchema,
});

const documentMessageSchema = z.object({
  type: z.literal('document'),
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  document: mediaObjectSchema.extend({ filename: z.string().optional() }),
});

const reactionMessageSchema = z.object({
  type: z.literal('reaction'),
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  reaction: z.object({ message_id: z.string(), emoji: z.string().optional() }),
});

const knownMessageSchema = z.discriminatedUnion('type', [
  textMessageSchema,
  imageMessageSchema,
  documentMessageSchema,
  reactionMessageSchema,
]);

/** Loose enough to accept message types we don't model yet (location, sticker, ...). */
const rawMessageSchema = z.object({ type: z.string().optional() }).passthrough();

const webhookValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z.object({ phone_number_id: z.string().optional() }).partial().optional(),
    contacts: z
      .array(
        z.object({
          profile: z.object({ name: z.string().optional() }).partial().optional(),
          wa_id: z.string().optional(),
        }),
      )
      .optional(),
    messages: z.array(rawMessageSchema).optional(),
    statuses: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

const webhookPayloadSchema = z
  .object({
    object: z.string().optional(),
    entry: z.array(
      z.object({
        id: z.string().optional(),
        changes: z.array(z.object({ field: z.string().optional(), value: webhookValueSchema })),
      }),
    ),
  })
  .passthrough();

function toTimestamp(raw: string): Date {
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}

function toInboundEvent(
  rawMessage: z.infer<typeof rawMessageSchema>,
  contactNameByWaId: ReadonlyMap<string, string | undefined>,
  toPhoneNumberId: string | undefined,
): WhatsAppInboundEvent {
  const from = typeof rawMessage.from === 'string' ? rawMessage.from : 'unknown';
  const messageId = typeof rawMessage.id === 'string' ? rawMessage.id : randomUUID();
  const timestamp =
    typeof rawMessage.timestamp === 'string' ? toTimestamp(rawMessage.timestamp) : new Date();
  const contactName = contactNameByWaId.get(from);
  const base: InboundBase = {
    messageId,
    from,
    timestamp,
    ...(contactName ? { contactName } : {}),
    ...(toPhoneNumberId ? { toPhoneNumberId } : {}),
  };

  const known = knownMessageSchema.safeParse(rawMessage);
  if (!known.success) {
    return { ...base, type: 'unsupported', rawType: rawMessage.type ?? 'unknown' };
  }

  const msg = known.data;
  switch (msg.type) {
    case 'text':
      return { ...base, type: 'text', text: msg.text.body };
    case 'image':
      return {
        ...base,
        type: 'image',
        mediaId: msg.image.id,
        mimeType: msg.image.mime_type,
        ...(msg.image.caption ? { caption: msg.image.caption } : {}),
      };
    case 'document':
      return {
        ...base,
        type: 'document',
        mediaId: msg.document.id,
        mimeType: msg.document.mime_type,
        ...(msg.document.filename ? { filename: msg.document.filename } : {}),
        ...(msg.document.caption ? { caption: msg.document.caption } : {}),
      };
    case 'reaction':
      return {
        ...base,
        type: 'reaction',
        emoji: msg.reaction.emoji ?? '',
        reactedToMessageId: msg.reaction.message_id,
      };
  }
}

/**
 * Parses a raw WhatsApp Cloud API webhook POST body into normalized inbound
 * events. Pure — no I/O, no config — so it's usable both as
 * `WhatsAppTool.receiveMessage` and directly in tests. Returns `[]` for
 * payloads that don't parse as a webhook shape, or that carry no `messages`
 * (e.g. a delivery/read status-only payload) — that's the normal case for
 * most webhook deliveries, not an error.
 */
export function receiveMessage(payload: unknown): WhatsAppInboundEvent[] {
  const parsed = webhookPayloadSchema.safeParse(payload);
  if (!parsed.success) return [];

  const events: WhatsAppInboundEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const contactNameByWaId = new Map(
        (change.value.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name] as const),
      );
      for (const rawMessage of change.value.messages ?? []) {
        events.push(
          toInboundEvent(rawMessage, contactNameByWaId, change.value.metadata?.phone_number_id),
        );
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Outbound: config, retry/backoff, errors
// ---------------------------------------------------------------------------

export interface WhatsAppToolConfig {
  apiToken: string;
  phoneNumberId: string;
  apiVersion: string;
  baseUrl: string;
  maxRetries: number;
  retryBaseDelayMs: number;
  broadcastConcurrency: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests so retry backoff doesn't actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Builds a WhatsAppToolConfig from the app's env schema — the one place this tool touches env. */
export function whatsappToolConfigFromEnv(env: Env): WhatsAppToolConfig {
  if (!env.WHATSAPP_CLOUD_API_TOKEN) {
    throw new Error('WHATSAPP_CLOUD_API_TOKEN is required to create the WhatsApp tool.');
  }
  if (!env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID is required to create the WhatsApp tool.');
  }
  return {
    apiToken: env.WHATSAPP_CLOUD_API_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: env.WHATSAPP_API_VERSION,
    baseUrl: env.WHATSAPP_GRAPH_API_BASE_URL,
    maxRetries: env.WHATSAPP_MAX_RETRIES,
    retryBaseDelayMs: env.WHATSAPP_RETRY_BASE_DELAY_MS,
    broadcastConcurrency: env.WHATSAPP_BROADCAST_CONCURRENCY,
  };
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extracts Meta's `Retry-After` (seconds) header if present, else `undefined`. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Performs a fetch with exponential backoff + jitter on 429 (rate limit) and
 * 5xx responses, and on network errors. Honors `Retry-After` when present.
 * Throws `WhatsAppApiError` for a non-retryable or exhausted-retries failure.
 */
async function requestWithRetry(
  config: WhatsAppToolConfig,
  input: string,
  init: RequestInit,
): Promise<Response> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleepImpl ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (err) {
      lastError = err;
      if (attempt === config.maxRetries) break;
      await sleep(backoffDelay(config.retryBaseDelayMs, attempt));
      continue;
    }

    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === config.maxRetries) {
      const body = await response.text().catch(() => undefined);
      throw new WhatsAppApiError(
        `WhatsApp Cloud API request failed with status ${response.status}`,
        response.status,
        safeJsonParse(body),
      );
    }

    const delay = retryAfterMs(response) ?? backoffDelay(config.retryBaseDelayMs, attempt);
    await sleep(delay);
  }

  throw new WhatsAppApiError(
    `WhatsApp Cloud API request failed after ${config.maxRetries + 1} attempt(s): ${String(lastError)}`,
    0,
    lastError,
  );
}

function backoffDelay(baseDelayMs: number, attempt: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

function safeJsonParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function graphUrl(config: WhatsAppToolConfig, segment: string): string {
  return `${config.baseUrl}/${config.apiVersion}/${segment}`;
}

// ---------------------------------------------------------------------------
// Outbound: send / reply
// ---------------------------------------------------------------------------

export interface WhatsAppSendResult {
  messageId: string;
  to: string;
}

interface SendMessagesApiResponse {
  messaging_product: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

async function postTextMessage(
  config: WhatsAppToolConfig,
  to: string,
  text: string,
  inReplyToMessageId?: string,
): Promise<WhatsAppSendResult> {
  const response = await requestWithRetry(
    config,
    graphUrl(config, `${config.phoneNumberId}/messages`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
        ...(inReplyToMessageId ? { context: { message_id: inReplyToMessageId } } : {}),
      }),
    },
  );

  const data = (await response.json()) as SendMessagesApiResponse;
  const messageId = data.messages[0]?.id;
  if (!messageId) {
    throw new WhatsAppApiError(
      'WhatsApp Cloud API response had no message id.',
      response.status,
      data,
    );
  }
  return { messageId, to: data.contacts?.[0]?.wa_id ?? to };
}

// ---------------------------------------------------------------------------
// Outbound: broadcast
// ---------------------------------------------------------------------------

export interface BroadcastFailure {
  to: string;
  error: string;
}

export interface BroadcastResult {
  /** One entry per recipient the broadcast succeeded for — the last message sent to them, when a recipient gets more than one (text + attachments). */
  sent: WhatsAppSendResult[];
  failed: BroadcastFailure[];
  durationMs: number;
}

/** An already-uploaded media item (see `uploadImage`/`uploadPDF`) to attach to a broadcast message. */
export interface BroadcastAttachment {
  type: 'image' | 'document';
  mediaId: string;
  /** Shown as the file name in WhatsApp; only meaningful for `'document'`. */
  filename?: string;
}

export interface BroadcastContent {
  /** Sent as its own message per recipient when non-empty. */
  text?: string;
  /** Sent as one message per recipient per attachment, after `text`. */
  attachments?: BroadcastAttachment[];
}

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex++;
    if (index >= items.length) return;
    results[index] = await worker(items[index] as T);
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
  return results;
}

async function postMediaMessage(
  config: WhatsAppToolConfig,
  to: string,
  attachment: BroadcastAttachment,
): Promise<WhatsAppSendResult> {
  const mediaPayload =
    attachment.type === 'document'
      ? {
          id: attachment.mediaId,
          ...(attachment.filename ? { filename: attachment.filename } : {}),
        }
      : { id: attachment.mediaId };

  const response = await requestWithRetry(
    config,
    graphUrl(config, `${config.phoneNumberId}/messages`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: attachment.type,
        [attachment.type]: mediaPayload,
      }),
    },
  );

  const data = (await response.json()) as SendMessagesApiResponse;
  const messageId = data.messages[0]?.id;
  if (!messageId) {
    throw new WhatsAppApiError(
      'WhatsApp Cloud API response had no message id.',
      response.status,
      data,
    );
  }
  return { messageId, to: data.contacts?.[0]?.wa_id ?? to };
}

/**
 * Fans a message out to `recipients` with at most `broadcastConcurrency` in
 * flight at once (HLD Sec 17's <30s broadcast NFR — see
 * `modules/broadcast.ts` for where that bound is chosen). `content` may be
 * a bare string (text only, the original shape) or `{ text?, attachments? }`
 * to also send image/PDF attachments (HLD Sec 6.1) — each recipient gets
 * `text` (if any) as one message, then each attachment as its own message,
 * sequentially for that recipient but concurrently across recipients.
 */
async function broadcastMessage(
  config: WhatsAppToolConfig,
  recipients: readonly string[],
  content: string | BroadcastContent,
): Promise<BroadcastResult> {
  const { text, attachments } =
    typeof content === 'string' ? { text: content, attachments: undefined } : content;
  const startedAt = Date.now();
  const sent: WhatsAppSendResult[] = [];
  const failed: BroadcastFailure[] = [];

  await mapWithConcurrency(recipients, config.broadcastConcurrency, async (to) => {
    try {
      let result: WhatsAppSendResult | undefined;
      if (text) result = await postTextMessage(config, to, text);
      for (const attachment of attachments ?? []) {
        result = await postMediaMessage(config, to, attachment);
      }
      if (!result) {
        throw new Error('broadcastMessage requires text and/or at least one attachment.');
      }
      sent.push(result);
    } catch (err) {
      failed.push({ to, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return { sent, failed, durationMs: Date.now() - startedAt };
}

// ---------------------------------------------------------------------------
// Outbound: media (upload / download)
// ---------------------------------------------------------------------------

export interface UploadMediaInput {
  filePath?: string;
  buffer?: Buffer;
  /** Required when using `buffer`; inferred from `filePath` extension when omitted. */
  filename?: string;
  /** Inferred from extension when omitted. */
  mimeType?: string;
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function inferMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeType = EXTENSION_MIME_TYPES[ext];
  if (!mimeType) {
    throw new Error(`Cannot infer MIME type for "${filename}" — pass mimeType explicitly.`);
  }
  return mimeType;
}

async function resolveUploadBytes(input: UploadMediaInput): Promise<{
  bytes: Buffer;
  filename: string;
  mimeType: string;
}> {
  if (input.buffer) {
    if (!input.filename) throw new Error('filename is required when uploading from a buffer.');
    return {
      bytes: input.buffer,
      filename: input.filename,
      mimeType: input.mimeType ?? inferMimeType(input.filename),
    };
  }
  if (input.filePath) {
    const bytes = await readFile(input.filePath);
    const filename = input.filename ?? path.basename(input.filePath);
    return { bytes, filename, mimeType: input.mimeType ?? inferMimeType(filename) };
  }
  throw new Error('uploadImage/uploadPDF requires either filePath or buffer.');
}

export interface UploadMediaResult {
  mediaId: string;
}

async function uploadMedia(
  config: WhatsAppToolConfig,
  input: UploadMediaInput,
): Promise<UploadMediaResult> {
  const { bytes, filename, mimeType } = await resolveUploadBytes(input);

  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', mimeType);
  form.set('file', new Blob([bytes], { type: mimeType }), filename);

  const response = await requestWithRetry(
    config,
    graphUrl(config, `${config.phoneNumberId}/media`),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiToken}` },
      body: form,
    },
  );

  const data = (await response.json()) as { id?: string };
  if (!data.id) {
    throw new WhatsAppApiError('WhatsApp Cloud API media upload had no id.', response.status, data);
  }
  return { mediaId: data.id };
}

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

async function downloadMedia(
  config: WhatsAppToolConfig,
  mediaId: string,
): Promise<DownloadedMedia> {
  const metaResponse = await requestWithRetry(config, graphUrl(config, mediaId), {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  const meta = (await metaResponse.json()) as { url?: string; mime_type?: string };
  if (!meta.url) {
    throw new WhatsAppApiError(
      'WhatsApp Cloud API media lookup had no url.',
      metaResponse.status,
      meta,
    );
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const fileResponse = await fetchImpl(meta.url, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  if (!fileResponse.ok) {
    throw new WhatsAppApiError(
      `Failed to download media ${mediaId}: status ${fileResponse.status}`,
      fileResponse.status,
      undefined,
    );
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: meta.mime_type ?? 'application/octet-stream',
  };
}

// ---------------------------------------------------------------------------
// Tool interface + factory
// ---------------------------------------------------------------------------

export interface WhatsAppTool {
  receiveMessage(payload: unknown): WhatsAppInboundEvent[];
  sendMessage(to: string, text: string): Promise<WhatsAppSendResult>;
  replyMessage(to: string, text: string, inReplyToMessageId: string): Promise<WhatsAppSendResult>;
  broadcastMessage(
    recipients: readonly string[],
    content: string | BroadcastContent,
  ): Promise<BroadcastResult>;
  uploadImage(input: UploadMediaInput): Promise<UploadMediaResult>;
  uploadPDF(input: UploadMediaInput): Promise<UploadMediaResult>;
  downloadMedia(mediaId: string): Promise<DownloadedMedia>;
}

export function createWhatsAppTool(config: WhatsAppToolConfig): WhatsAppTool {
  return {
    receiveMessage,
    sendMessage: (to, text) => postTextMessage(config, to, text),
    replyMessage: (to, text, inReplyToMessageId) =>
      postTextMessage(config, to, text, inReplyToMessageId),
    broadcastMessage: (recipients, content) => broadcastMessage(config, recipients, content),
    uploadImage: (input) => uploadMedia(config, input),
    uploadPDF: (input) => uploadMedia(config, input),
    downloadMedia: (mediaId) => downloadMedia(config, mediaId),
  };
}
