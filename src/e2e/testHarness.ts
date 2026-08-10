/**
 * e2e/testHarness.ts
 *
 * Shared builder for the end-to-end workflow tests in this directory
 * (docs/test-coverage.md). Not itself a test file (vitest.config.ts's
 * `include: ['src/**\/*.{test,spec}.ts']` won't pick it up) — a fully
 * wired `createOrchestrator()` instance, built the same way
 * `gateway/orchestrator.test.ts`'s own `makeDeps()` does, so these "does
 * the whole HLD workflow work" tests exercise the *real* orchestrator +
 * modules wiring (agent/guardrails.ts, agent/escalation.ts,
 * modules/faq.ts, modules/complaints.ts, modules/suggestions.ts,
 * modules/broadcast.ts, modules/escalation.ts all run for real) rather
 * than re-testing one module in isolation the way the per-module unit
 * tests already do.
 *
 * Only the outermost I/O — WhatsApp, the DB-backed tools, Gemini — is
 * faked, exactly like every unit test in this repo already does (no real
 * network/DB in `pnpm test`; that's what the `scripts/_verify-*.ts`
 * throwaway scripts + docs "Verified live" sections are for). What's
 * different here is the *latency* those fakes simulate — see each e2e
 * file's own comments for why a given test injects a delay instead of
 * resolving instantly.
 */
import { vi } from 'vitest';
import { createOrchestrator, type OrchestratorDeps } from '../gateway/orchestrator.js';
import { InMemorySessionStore } from '../gateway/session.js';
import { createToolRegistry, type ToolRegistryTools } from '../gateway/toolRegistry.js';

export function makeToolRegistryTools(
  overrides: Partial<ToolRegistryTools> = {},
): ToolRegistryTools {
  return {
    whatsapp: {
      receiveMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.out', to: 'x' }),
      replyMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.out', to: 'x' }),
      broadcastMessage: vi.fn().mockResolvedValue({ sent: [], failed: [], durationMs: 5 }),
      uploadImage: vi.fn(),
      uploadPDF: vi.fn(),
      downloadMedia: vi.fn(),
    },
    knowledgeSearch: {
      search: vi.fn().mockResolvedValue([]),
    },
    complaint: {
      createComplaint: vi.fn().mockResolvedValue({
        id: 'c1',
        ticketId: 'TCK-2026-0001',
        status: 'open',
        flatNumber: 'A-403',
      }),
      getComplaintByTicketId: vi.fn().mockResolvedValue(null),
    },
    suggestion: {
      createSuggestion: vi.fn().mockResolvedValue({ id: 's1', category: 'maintenance' }),
    },
    broadcast: {
      draftAnnouncement: vi.fn().mockResolvedValue({
        id: 'a1234567-aaaa-bbbb-cccc-000000000000',
        status: 'pending_approval',
        body: 'x',
      }),
      getAnnouncement: vi.fn().mockResolvedValue({
        id: 'a1234567-aaaa-bbbb-cccc-000000000000',
        status: 'pending_approval',
        body: 'x',
        author: '+919820099000',
        mediaUrls: [],
        scheduledAt: null,
        approvedBy: null,
      }),
      approveAndSend: vi.fn().mockResolvedValue({
        announcement: {
          id: 'a1234567-aaaa-bbbb-cccc-000000000000',
          status: 'broadcast',
          body: 'x',
        },
        broadcast: { sent: [{ messageId: 'm1', to: '1' }], failed: [], durationMs: 100 },
        approvedBy: '+919820099000',
      }),
      markApprovedForSchedule: vi.fn().mockResolvedValue({
        id: 'a1234567-aaaa-bbbb-cccc-000000000000',
        status: 'approved',
        body: 'x',
      }),
      sendApprovedAnnouncement: vi.fn().mockResolvedValue({
        announcement: {
          id: 'a1234567-aaaa-bbbb-cccc-000000000000',
          status: 'broadcast',
          body: 'x',
        },
        broadcast: { sent: [{ messageId: 'm1', to: '1' }], failed: [], durationMs: 100 },
        approvedBy: '+919820099000',
      }),
    },
    escalation: {
      createEscalation: vi.fn().mockResolvedValue({
        id: 'e1234567-aaaa-bbbb-cccc-000000000000',
        status: 'pending',
        category: 'committee_decision',
      }),
      acknowledgeEscalation: vi.fn().mockResolvedValue({
        id: 'e1234567-aaaa-bbbb-cccc-000000000000',
        status: 'acknowledged',
        category: 'committee_decision',
      }),
      listOpenEscalations: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

export function makeConversationStore() {
  return {
    appendMessage: vi.fn().mockResolvedValue({
      id: 'm1',
      conversationId: 'c1',
      direction: 'out',
      senderType: 'ai',
      body: '',
      mediaUrl: null,
      createdAt: new Date(),
    }),
    getRecentHistoryForPrompt: vi.fn().mockResolvedValue([]),
  };
}

export function makeAuditLog() {
  return {
    logForbiddenActionBlocked: vi.fn().mockResolvedValue(undefined),
    logBroadcastSent: vi.fn().mockResolvedValue(undefined),
    logAction: vi.fn().mockResolvedValue(undefined),
  };
}

export function makeSuggestionClassifier() {
  return { classify: vi.fn().mockResolvedValue('maintenance') };
}

export function makeLanguageImprover() {
  return { improve: vi.fn().mockImplementation((rawText: string) => Promise.resolve(rawText)) };
}

export function makeBroadcastScheduler() {
  return { scheduleBroadcast: vi.fn().mockResolvedValue(undefined) };
}

/** Builds a full `OrchestratorDeps` — same shape/defaults as gateway/orchestrator.test.ts's own `makeDeps`. */
export function makeOrchestratorDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const tools = makeToolRegistryTools();
  return {
    toolRegistry: createToolRegistry(tools),
    conversationStore: makeConversationStore(),
    sessionStore: new InMemorySessionStore(1800),
    geminiResponder: { generateReply: vi.fn().mockResolvedValue('Gemini reply text.') },
    auditLog: makeAuditLog(),
    suggestionClassifier: makeSuggestionClassifier(),
    languageImprover: makeLanguageImprover(),
    broadcastScheduler: makeBroadcastScheduler(),
    secretaryNumber: '+919820099000',
    ...overrides,
  };
}

/** Convenience: builds deps + the orchestrator constructed from them, plus the underlying tool mocks for assertions. */
export function buildOrchestratorHarness(depsOverrides: Partial<OrchestratorDeps> = {}) {
  const deps = makeOrchestratorDeps(depsOverrides);
  const orchestrator = createOrchestrator(deps);
  return { orchestrator, deps };
}

/** A `setTimeout`-based delay — pairs with `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` so response-time-budget tests simulate real latency deterministically and fast (no real wall-clock waiting). */
export function delay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
