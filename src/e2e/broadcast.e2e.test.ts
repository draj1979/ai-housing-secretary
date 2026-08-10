/**
 * e2e/broadcast.e2e.test.ts
 *
 * HLD Sec 9 — Broadcast Workflow: "Secretary -> Private Chat -> Draft
 * Announcement -> AI Improves Language -> Approval -> Broadcast ->
 * Residents". End to end through `gateway/orchestrator.ts`'s real
 * `handleSecretaryEvent` secretary-command grammar and real
 * `modules/broadcast.ts`.
 *
 * The <30s delivery NFR specifically is a property of the *real*
 * concurrency-limited fan-out logic in `tools/whatsappTool.ts`'s
 * `broadcastMessage` (`mapWithConcurrency`), not something a fully-mocked
 * `broadcastMessage` could demonstrate either way — so the timing tests
 * below use the real `createWhatsAppTool` (only `fetch` itself faked, with
 * simulated per-recipient latency). `tools/broadcastTool.ts` itself is
 * still faked (an in-memory stand-in, same as every other e2e/unit test in
 * this repo) since it's a thin DB read/write wrapper around
 * `whatsapp.broadcastMessage` — the DB bookkeeping isn't what determines
 * delivery time, so faking it doesn't weaken what these tests actually
 * prove, and keeps `pnpm test` free of any real Postgres dependency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NFR_TARGETS } from '../config/constants.js';
import { createWhatsAppTool, type WhatsAppToolConfig } from '../tools/whatsappTool.js';
import { createBroadcastModule } from '../modules/broadcast.js';
import type { BroadcastModuleDeps } from '../modules/broadcast.js';
import { buildOrchestratorHarness, makeToolRegistryTools } from './testHarness.js';
import { createToolRegistry } from '../gateway/toolRegistry.js';
import type { WhatsAppInboundEvent } from '../tools/whatsappTool.js';

function secretaryEvent(text: string, messageId = 'wamid.sec1'): WhatsAppInboundEvent {
  return { type: 'text', messageId, from: '919820099000', timestamp: new Date(), text };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const ANNOUNCEMENT_ID = 'a1234567-aaaa-bbbb-cccc-000000000000';

/**
 * Real `whatsapp.broadcastMessage` (fake `fetch`, real concurrency-limited
 * fan-out) + real `createBroadcastModule`, with an in-memory
 * `broadcastTool` stand-in — see this file's header comment for why the
 * DB-touching tool specifically is faked here.
 */
function buildRealBroadcastStack(
  recipientCount: number,
  latencyMs: number,
  broadcastConcurrency = 5,
) {
  let sendCount = 0;
  const fetchImpl = vi.fn(
    (): Promise<Response> =>
      new Promise((resolve) => {
        sendCount += 1;
        setTimeout(
          () => resolve(jsonResponse({ messages: [{ id: `wamid.${sendCount}` }] })),
          latencyMs,
        );
      }),
  );

  const config: WhatsAppToolConfig = {
    apiToken: 'test-token',
    phoneNumberId: '109876543210001',
    apiVersion: 'v21.0',
    baseUrl: 'https://graph.example.test',
    maxRetries: 0,
    retryBaseDelayMs: 1,
    broadcastConcurrency,
    fetchImpl,
    sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const whatsapp = createWhatsAppTool(config);

  const phones = Array.from(
    { length: recipientCount },
    (_, i) => `+91982${String(i).padStart(7, '0')}`,
  );
  let draftedBody = '';

  const broadcastTool: BroadcastModuleDeps['broadcastTool'] = {
    draftAnnouncement: vi.fn(async (input) => {
      draftedBody = input.body;
      return { id: ANNOUNCEMENT_ID, status: 'pending_approval' as const, body: input.body };
    }),
    getAnnouncement: vi.fn(async () => ({
      id: ANNOUNCEMENT_ID,
      status: 'pending_approval' as const,
      body: draftedBody,
      author: '+919820099000',
      mediaUrls: [],
      scheduledAt: null,
      approvedBy: null,
    })),
    approveAndSend: vi.fn(async (_idPrefix: string, approvedBy: string) => {
      // The one call that matters for timing: the real, concurrency-limited fan-out.
      const broadcast = await whatsapp.broadcastMessage(phones, draftedBody);
      return {
        announcement: { id: ANNOUNCEMENT_ID, status: 'broadcast' as const, body: draftedBody },
        broadcast,
        approvedBy,
      };
    }),
    markApprovedForSchedule: vi.fn(),
    sendApprovedAnnouncement: vi.fn(),
  };

  const languageImprover = {
    improve: vi.fn().mockResolvedValue('[AI-formatted] Water tanker visit at 9am tomorrow.'),
  };
  const scheduler = { scheduleBroadcast: vi.fn() };
  const auditLog = { logBroadcastSent: vi.fn().mockResolvedValue(undefined) };
  const broadcastModule = createBroadcastModule({
    languageImprover,
    broadcastTool,
    whatsapp,
    auditLog,
    scheduler,
  });

  return { broadcastModule, broadcastTool, languageImprover, auditLog, phones };
}

describe('Broadcast Workflow (HLD Sec 9) — secretary command grammar', () => {
  it('drafts and previews without ever sending, then sends only on explicit approval', async () => {
    const languageImprover = {
      improve: vi.fn().mockResolvedValue('IMPROVED: Water tanker at 9am tomorrow.'),
    };
    const tools = makeToolRegistryTools();
    const { orchestrator, deps } = buildOrchestratorHarness({
      toolRegistry: createToolRegistry(tools),
      languageImprover,
    });

    await orchestrator.handleSecretaryEvent(secretaryEvent('Water tanker at 9am tomorrow.'));

    // AI improved the wording, and the draft is a preview only — never sent.
    expect(languageImprover.improve).toHaveBeenCalledWith('Water tanker at 9am tomorrow.');
    expect(tools.broadcast.draftAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'IMPROVED: Water tanker at 9am tomorrow.' }),
    );
    expect(tools.whatsapp.broadcastMessage).not.toHaveBeenCalled();
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('approve'),
      expect.any(String),
    );

    // Only "approve <ref>" actually sends.
    await orchestrator.handleSecretaryEvent(secretaryEvent('approve a1234567', 'wamid.sec2'));
    expect(tools.broadcast.approveAndSend).toHaveBeenCalledWith('a1234567', '+919820099000');
  });

  it(`delivers to all ${NFR_TARGETS.minResidentCapacity} seeded-scale residents within the <${NFR_TARGETS.broadcastTimeSeconds}s NFR budget once approved`, async () => {
    const { broadcastModule, phones } = buildRealBroadcastStack(
      NFR_TARGETS.minResidentCapacity,
      100, // ms per WhatsApp Cloud API call — realistic same-region round trip
    );

    const draft = await broadcastModule.draftAnnouncement({
      author: '+919820099000',
      body: 'AGM this Saturday 6pm at the clubhouse.',
    });

    const start = Date.now();
    const approvePromise = broadcastModule.approveAnnouncement({
      idPrefix: draft.announcement.id.slice(0, 8),
      approvedBy: '+919820099000',
    });
    await vi.advanceTimersByTimeAsync(NFR_TARGETS.broadcastTimeSeconds * 1000);
    const outcome = await approvePromise;
    const elapsedMs = Date.now() - start;

    expect(outcome.kind).toBe('sent');
    expect(outcome.recipientCount).toBe(phones.length);
    expect(outcome.failedCount).toBe(0);
    expect(elapsedMs).toBeLessThanOrEqual(NFR_TARGETS.broadcastTimeSeconds * 1000);
  });

  it(
    'FINDING: the default WHATSAPP_BROADCAST_CONCURRENCY (5) does not meet the <30s budget at ' +
      '1000 residents once per-message latency rises above ~150ms — flagged in docs/test-coverage.md, ' +
      'not treated as a hard failure here since real Meta API latency varies by deployment region',
    async () => {
      const { broadcastModule, phones } = buildRealBroadcastStack(
        NFR_TARGETS.minResidentCapacity,
        300,
      );

      const draft = await broadcastModule.draftAnnouncement({
        author: '+919820099000',
        body: 'Test.',
      });
      const start = Date.now();
      const approvePromise = broadcastModule.approveAnnouncement({
        idPrefix: draft.announcement.id.slice(0, 8),
        approvedBy: '+919820099000',
      });
      await vi.advanceTimersByTimeAsync(120_000);
      const outcome = await approvePromise;
      const elapsedMs = Date.now() - start;

      expect(outcome.recipientCount).toBe(phones.length);
      // Documents the actual behavior at this latency (~60s, not an
      // assertion that it's fine) — see docs/test-coverage.md's flagged
      // finding for the operational recommendation (raise
      // WHATSAPP_BROADCAST_CONCURRENCY for large societies).
      expect(elapsedMs).toBeGreaterThan(NFR_TARGETS.broadcastTimeSeconds * 1000);
    },
  );

  it('raising WHATSAPP_BROADCAST_CONCURRENCY comfortably restores the <30s budget at the same higher latency', async () => {
    const { broadcastModule, phones } = buildRealBroadcastStack(
      NFR_TARGETS.minResidentCapacity,
      300,
      20,
    );

    const draft = await broadcastModule.draftAnnouncement({
      author: '+919820099000',
      body: 'Test.',
    });
    const start = Date.now();
    const approvePromise = broadcastModule.approveAnnouncement({
      idPrefix: draft.announcement.id.slice(0, 8),
      approvedBy: '+919820099000',
    });
    await vi.advanceTimersByTimeAsync(NFR_TARGETS.broadcastTimeSeconds * 1000);
    const outcome = await approvePromise;
    const elapsedMs = Date.now() - start;

    expect(outcome.recipientCount).toBe(phones.length);
    expect(elapsedMs).toBeLessThanOrEqual(NFR_TARGETS.broadcastTimeSeconds * 1000);
  });
});
