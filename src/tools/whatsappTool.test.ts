import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWhatsAppTool,
  receiveMessage,
  whatsappToolConfigFromEnv,
  WhatsAppApiError,
  type WhatsAppToolConfig,
} from './whatsappTool.js';
import type { Env } from '../config/env.js';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/whatsapp',
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
}

// ---------------------------------------------------------------------------
// receiveMessage
// ---------------------------------------------------------------------------

describe('receiveMessage', () => {
  it('parses a text message', () => {
    const events = receiveMessage(loadFixture('text-message.json'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'text',
      from: '919820011002',
      contactName: 'Ravi Kulkarni',
      text: 'Water leakage in A-403 again, bathroom ceiling is damp.',
    });
    expect(events[0]?.messageId).toMatch(/^wamid\./);
    expect(events[0]?.timestamp).toBeInstanceOf(Date);
    expect(events[0]?.timestamp.getTime()).toBe(1770000000 * 1000);
  });

  it('carries which phone_number_id the message arrived on, for dual-number routing', () => {
    const aiNumberEvents = receiveMessage(loadFixture('text-message.json'));
    expect(aiNumberEvents[0]?.toPhoneNumberId).toBe('109876543210001');

    const secretaryNumberEvents = receiveMessage(loadFixture('secretary-number-message.json'));
    expect(secretaryNumberEvents[0]?.toPhoneNumberId).toBe('109876543210002');
    expect(secretaryNumberEvents[0]).toMatchObject({
      type: 'text',
      from: '919820099000',
      text: 'Reminder: water tanker visit rescheduled to Monday 7am.',
    });
  });

  it('parses an image message', () => {
    const events = receiveMessage(loadFixture('image-message.json'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'image',
      from: '919820011005',
      mediaId: '1234567890123456',
      mimeType: 'image/jpeg',
      caption: 'Broken clubhouse gate hinge',
    });
  });

  it('parses a document (PDF) message', () => {
    const events = receiveMessage(loadFixture('document-message.json'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'document',
      from: '919820011003',
      mediaId: '9876543210654321',
      mimeType: 'application/pdf',
      filename: 'leave-and-license-agreement.pdf',
      caption: 'Tenancy agreement for B-204',
    });
  });

  it('parses a reaction message', () => {
    const events = receiveMessage(loadFixture('reaction-message.json'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'reaction',
      from: '919820011002',
      emoji: '👍',
      reactedToMessageId: 'wamid.HBgLOTE5ODIwMDExMDAyFQIAEhggQTQ4RjQ5RjQ5RjQ5RjQ5RjQ5RjQ5RjQ5RjQA',
    });
  });

  it('returns an empty array for a status-only payload (no messages field)', () => {
    expect(receiveMessage(loadFixture('status-update.json'))).toEqual([]);
  });

  it('normalizes an unmodeled message type (e.g. location) to "unsupported" instead of throwing', () => {
    const events = receiveMessage(loadFixture('unsupported-message.json'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'unsupported',
      rawType: 'location',
      from: '919820011004',
    });
  });

  it('returns an empty array for garbage input instead of throwing', () => {
    expect(receiveMessage(null)).toEqual([]);
    expect(receiveMessage(undefined)).toEqual([]);
    expect(receiveMessage('not a webhook payload')).toEqual([]);
    expect(receiveMessage({})).toEqual([]);
    expect(receiveMessage({ entry: 'not an array' })).toEqual([]);
  });

  it('flattens messages across multiple entries/changes in one payload', () => {
    const textPayload = loadFixture('text-message.json') as {
      entry: Array<{ changes: Array<{ value: { messages: unknown[] } }> }>;
    };
    const imagePayload = loadFixture('image-message.json') as typeof textPayload;

    const combined = {
      object: 'whatsapp_business_account',
      entry: [...textPayload.entry, ...imagePayload.entry],
    };
    const events = receiveMessage(combined);

    expect(events.map((e) => e.type)).toEqual(['text', 'image']);
  });
});

// ---------------------------------------------------------------------------
// Outbound (mocked fetch)
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function testConfig(overrides: Partial<WhatsAppToolConfig> = {}): WhatsAppToolConfig {
  return {
    apiToken: 'test-token',
    phoneNumberId: '109876543210001',
    apiVersion: 'v21.0',
    baseUrl: 'https://graph.example.test',
    maxRetries: 3,
    retryBaseDelayMs: 10,
    broadcastConcurrency: 2,
    sleepImpl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('sendMessage / replyMessage', () => {
  it('POSTs to the messages endpoint with the expected body and auth header', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(input).toBe('https://graph.example.test/v21.0/109876543210001/messages');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        messaging_product: 'whatsapp',
        to: '919820011002',
        type: 'text',
        text: { body: 'Hello resident' },
      });
      return jsonResponse({
        messaging_product: 'whatsapp',
        contacts: [{ input: '919820011002', wa_id: '919820011002' }],
        messages: [{ id: 'wamid.OUT1' }],
      });
    });

    const tool = createWhatsAppTool(testConfig({ fetchImpl }));
    const result = await tool.sendMessage('919820011002', 'Hello resident');

    expect(result).toEqual({ messageId: 'wamid.OUT1', to: '919820011002' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('threads a reply via the "context" field', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.context).toEqual({ message_id: 'wamid.ORIGINAL' });
      return jsonResponse({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.REPLY' }] });
    });

    const tool = createWhatsAppTool(testConfig({ fetchImpl }));
    const result = await tool.replyMessage('919820011002', 'Ticket created.', 'wamid.ORIGINAL');

    expect(result.messageId).toBe('wamid.REPLY');
  });
});

describe('retry / backoff', () => {
  it('retries on 429 and succeeds once the API stops throttling', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt++;
      if (attempt < 3) return new Response('rate limited', { status: 429 });
      return jsonResponse({ messages: [{ id: 'wamid.OK' }] });
    });

    const tool = createWhatsAppTool(testConfig({ fetchImpl, maxRetries: 5 }));
    const result = await tool.sendMessage('919820011002', 'hi');

    expect(result.messageId).toBe('wamid.OK');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('honors the Retry-After header instead of the exponential default', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } });
      }
      return jsonResponse({ messages: [{ id: 'wamid.OK' }] });
    });

    const tool = createWhatsAppTool(
      testConfig({ fetchImpl, sleepImpl, retryBaseDelayMs: 999_999 }),
    );
    await tool.sendMessage('919820011002', 'hi');

    expect(sleepImpl).toHaveBeenCalledWith(2000); // 2s from Retry-After, not the huge exponential default
  });

  it('retries on 5xx responses', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt++;
      if (attempt < 2) return new Response('server error', { status: 503 });
      return jsonResponse({ messages: [{ id: 'wamid.OK' }] });
    });

    const tool = createWhatsAppTool(testConfig({ fetchImpl }));
    await tool.sendMessage('919820011002', 'hi');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable 4xx (e.g. bad request)', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 }));
    const tool = createWhatsAppTool(testConfig({ fetchImpl }));

    await expect(tool.sendMessage('919820011002', 'hi')).rejects.toThrow(WhatsAppApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws WhatsAppApiError after exhausting retries on persistent 5xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 500 }));
    const tool = createWhatsAppTool(testConfig({ fetchImpl, maxRetries: 2 }));

    await expect(tool.sendMessage('919820011002', 'hi')).rejects.toThrow(WhatsAppApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it('retries on a network error (fetch throws) and eventually gives up', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const tool = createWhatsAppTool(testConfig({ fetchImpl, maxRetries: 1 }));

    await expect(tool.sendMessage('919820011002', 'hi')).rejects.toThrow(WhatsAppApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('broadcastMessage', () => {
  it('sends to every recipient and reports durationMs', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const to = new URLSearchParams(String(input).split('?')[1]).get('to');
      return jsonResponse({ messages: [{ id: `wamid.${to ?? 'x'}` }] });
    });
    const tool = createWhatsAppTool(testConfig({ fetchImpl }));

    const result = await tool.broadcastMessage(
      ['919820011001', '919820011002', '919820011003'],
      'Water supply will be interrupted 10am-2pm tomorrow.',
    );

    expect(result.sent).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('records per-recipient failures without aborting the rest of the broadcast', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.to === '919820011002') return new Response('invalid number', { status: 400 });
      return jsonResponse({ messages: [{ id: 'wamid.OK' }] });
    });
    const tool = createWhatsAppTool(testConfig({ fetchImpl }));

    const result = await tool.broadcastMessage(
      ['919820011001', '919820011002', '919820011003'],
      'Announcement',
    );

    expect(result.sent).toHaveLength(2);
    expect(result.failed).toEqual([{ to: '919820011002', error: expect.any(String) }]);
  });

  it('never exceeds the configured broadcast concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return jsonResponse({ messages: [{ id: 'wamid.OK' }] });
    });

    const tool = createWhatsAppTool(testConfig({ fetchImpl, broadcastConcurrency: 2 }));
    await tool.broadcastMessage(['a', 'b', 'c', 'd', 'e', 'f'], 'msg');

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('sends text then each attachment as its own message per recipient', async () => {
    const calls: Array<{ to: string; type: string }> = [];
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      calls.push({ to: body.to, type: body.type });
      return jsonResponse({ messages: [{ id: `wamid.${body.type}` }] });
    });
    const tool = createWhatsAppTool(testConfig({ fetchImpl }));

    const result = await tool.broadcastMessage(['919820011001'], {
      text: 'Notice attached.',
      attachments: [
        { type: 'image', mediaId: 'media-img-1' },
        { type: 'document', mediaId: 'media-doc-1', filename: 'notice.pdf' },
      ],
    });

    expect(calls).toEqual([
      { to: '919820011001', type: 'text' },
      { to: '919820011001', type: 'image' },
      { to: '919820011001', type: 'document' },
    ]);
    expect(result.sent).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it('sends attachment-only content (no text) with the correct media payload', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.type).toBe('document');
      expect(body.document).toEqual({ id: 'media-doc-1', filename: 'notice.pdf' });
      return jsonResponse({ messages: [{ id: 'wamid.doc' }] });
    });
    const tool = createWhatsAppTool(testConfig({ fetchImpl }));

    const result = await tool.broadcastMessage(['919820011001'], {
      attachments: [{ type: 'document', mediaId: 'media-doc-1', filename: 'notice.pdf' }],
    });

    expect(result.sent).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails a recipient with no text and no attachments', async () => {
    const fetchImpl = vi.fn();
    const tool = createWhatsAppTool(testConfig({ fetchImpl }));

    const result = await tool.broadcastMessage(['919820011001'], {});

    expect(result.sent).toHaveLength(0);
    expect(result.failed).toEqual([{ to: '919820011001', error: expect.any(String) }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('uploadImage / uploadPDF', () => {
  it('uploads a buffer as multipart form data and returns the media id', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(input).toBe('https://graph.example.test/v21.0/109876543210001/media');
      const form = init?.body as FormData;
      expect(form.get('messaging_product')).toBe('whatsapp');
      expect(form.get('type')).toBe('image/jpeg');
      return jsonResponse({ id: 'media-abc123' });
    });

    const tool = createWhatsAppTool(testConfig({ fetchImpl }));
    const result = await tool.uploadImage({
      buffer: Buffer.from('fake-jpeg-bytes'),
      filename: 'gate.jpg',
    });

    expect(result).toEqual({ mediaId: 'media-abc123' });
  });

  it('uploads a PDF and infers the mime type from the filename', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('type')).toBe('application/pdf');
      return jsonResponse({ id: 'media-pdf1' });
    });

    const tool = createWhatsAppTool(testConfig({ fetchImpl }));
    const result = await tool.uploadPDF({
      buffer: Buffer.from('%PDF-1.4 fake'),
      filename: 'notice.pdf',
    });

    expect(result).toEqual({ mediaId: 'media-pdf1' });
  });

  it('throws when the mime type cannot be inferred and none is provided', async () => {
    const tool = createWhatsAppTool(testConfig({ fetchImpl: vi.fn() }));
    await expect(
      tool.uploadImage({ buffer: Buffer.from('x'), filename: 'noext' }),
    ).rejects.toThrow();
  });

  it('requires a filename when uploading from a buffer', async () => {
    const tool = createWhatsAppTool(testConfig({ fetchImpl: vi.fn() }));
    await expect(tool.uploadImage({ buffer: Buffer.from('x') })).rejects.toThrow();
  });
});

describe('downloadMedia', () => {
  const GRAPH_METADATA_URL = 'https://graph.example.test/v21.0/media-abc123';
  const CDN_URL = 'https://cdn.example.test/media-abc123';

  it('resolves the media URL then downloads the bytes', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) === GRAPH_METADATA_URL) {
        return jsonResponse({ url: CDN_URL, mime_type: 'application/pdf' });
      }
      if (String(input) === CDN_URL) {
        return new Response(Buffer.from('%PDF-1.4 fake bytes'), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${String(input)}`);
    });

    const tool = createWhatsAppTool(testConfig({ fetchImpl }));
    const result = await tool.downloadMedia('media-abc123');

    expect(result.mimeType).toBe('application/pdf');
    expect(result.buffer.toString()).toBe('%PDF-1.4 fake bytes');
  });

  it('throws if the final media download fails', async () => {
    const graphUrl = 'https://graph.example.test/v21.0/media-x';
    const cdnUrl = 'https://cdn.example.test/media-x';
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) === graphUrl) {
        return jsonResponse({ url: cdnUrl, mime_type: 'image/jpeg' });
      }
      if (String(input) === cdnUrl) {
        return new Response('gone', { status: 404 });
      }
      throw new Error(`unexpected fetch to ${String(input)}`);
    });

    const tool = createWhatsAppTool(testConfig({ fetchImpl }));
    await expect(tool.downloadMedia('media-x')).rejects.toThrow(WhatsAppApiError);
  });
});

// ---------------------------------------------------------------------------
// whatsappToolConfigFromEnv
// ---------------------------------------------------------------------------

describe('whatsappToolConfigFromEnv', () => {
  function baseEnv(overrides: Partial<Env> = {}): Env {
    return {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      PORT: 8080,
      LOG_RETENTION_DAYS: 90,
      GEMINI_MODEL: 'gemini-flash-lite',
      WHATSAPP_API_VERSION: 'v21.0',
      WHATSAPP_GRAPH_API_BASE_URL: 'https://graph.facebook.com',
      WHATSAPP_MAX_RETRIES: 3,
      WHATSAPP_RETRY_BASE_DELAY_MS: 500,
      WHATSAPP_BROADCAST_CONCURRENCY: 5,
      INBOUND_QUEUE_CONCURRENCY: 5,
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/test',
      DATABASE_SSL: false,
      REDIS_URL: 'redis://localhost:6379',
      VECTOR_DB_PROVIDER: 'pgvector',
      CHROMA_COLLECTION: 'society_knowledge_base',
      EMBEDDING_MODEL: 'text-embedding-004',
      JWT_EXPIRES_IN: '12h',
      GCP_REGION: 'asia-south1',
      GCP_COMPUTE_ZONE: 'asia-south1-a',
      SECRETS_SOURCE: 'env',
      BACKUP_SCHEDULE_CRON: '0 2 * * *',
      ...overrides,
    } as Env;
  }

  it('builds a config from env when both required WhatsApp vars are set', () => {
    const config = whatsappToolConfigFromEnv(
      baseEnv({ WHATSAPP_CLOUD_API_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '123' }),
    );
    expect(config).toMatchObject({
      apiToken: 'tok',
      phoneNumberId: '123',
      apiVersion: 'v21.0',
      baseUrl: 'https://graph.facebook.com',
      maxRetries: 3,
      retryBaseDelayMs: 500,
      broadcastConcurrency: 5,
    });
  });

  it('throws when WHATSAPP_CLOUD_API_TOKEN is missing', () => {
    expect(() => whatsappToolConfigFromEnv(baseEnv({ WHATSAPP_PHONE_NUMBER_ID: '123' }))).toThrow(
      /WHATSAPP_CLOUD_API_TOKEN/,
    );
  });

  it('throws when WHATSAPP_PHONE_NUMBER_ID is missing', () => {
    expect(() => whatsappToolConfigFromEnv(baseEnv({ WHATSAPP_CLOUD_API_TOKEN: 'tok' }))).toThrow(
      /WHATSAPP_PHONE_NUMBER_ID/,
    );
  });
});

describe('createWhatsAppTool', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('wires receiveMessage to the pure parser (no network involved)', () => {
    const tool = createWhatsAppTool(testConfig({ fetchImpl: vi.fn() }));
    const events = tool.receiveMessage(loadFixture('text-message.json'));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('text');
  });
});
