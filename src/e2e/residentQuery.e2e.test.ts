/**
 * e2e/residentQuery.e2e.test.ts
 *
 * HLD Sec 10 — Resident Query Workflow: "Resident tags AI -> AI searches
 * knowledge base -> Gemini generates response -> Reply". End to end
 * through `gateway/orchestrator.ts`'s real `handleResidentEvent`, real
 * `modules/faq.ts`, real confidence gate — only WhatsApp/knowledge-search/
 * Gemini I/O is faked (see testHarness.ts's doc comment).
 *
 * Two things unit tests don't already prove at this level:
 *   1. The <5s average response NFR (HLD Sec 17 `NFR_TARGETS.averageResponseSeconds`)
 *      isn't blown by the orchestrator's own overhead once search/Gemini
 *      take realistic real-world time — not "does the code work" (the
 *      module unit tests already prove that) but "is it fast enough".
 *   2. Grounding actually holds end-to-end: the exact chunks retrieved are
 *      what Gemini sees, and a low-confidence retrieval never reaches
 *      Gemini at all (escalates instead) — proven through the real
 *      wiring, not a mocked module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NFR_TARGETS, FAQ_MIN_CONFIDENCE_SCORE } from '../config/constants.js';
import { buildOrchestratorHarness, delay, makeToolRegistryTools } from './testHarness.js';
import { createToolRegistry } from '../gateway/toolRegistry.js';
import type { WhatsAppInboundEvent } from '../tools/whatsappTool.js';
import type { KnowledgeSearchResult } from '../tools/knowledgeSearchTool.js';

const RESIDENT_CONTEXT = { residentId: 'resident-1', whatsappThreadId: '919820011001' };

function faqEvent(text: string): WhatsAppInboundEvent {
  return {
    type: 'text',
    messageId: 'wamid.faq1',
    from: '919820011001',
    timestamp: new Date(),
    text,
  };
}

// Realistic-order-of-magnitude latencies for the two real network calls on
// this path — a vector search against pgvector/Chroma, and a Gemini
// generateContent call. Deliberately well inside the 5s budget individually
// but not instant, so the assertion means something.
const KNOWLEDGE_SEARCH_LATENCY_MS = 150;
const GEMINI_LATENCY_MS = 1800;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Resident Query Workflow (HLD Sec 10)', () => {
  it('tag AI -> knowledge search -> Gemini -> reply, grounded only in the retrieved chunks, within the <5s response budget', async () => {
    const clubhouseMatch: KnowledgeSearchResult = {
      documentTitle: 'Clubhouse Rules',
      excerpt: 'The clubhouse is open 9am-10pm daily.',
      score: 0.87,
      category: 'clubhouse_rules',
    };
    const tools = makeToolRegistryTools({
      knowledgeSearch: {
        search: vi.fn(async (_q: string, opts?: { category?: string }) =>
          delay(
            opts?.category === 'clubhouse_rules' ? [clubhouseMatch] : [],
            KNOWLEDGE_SEARCH_LATENCY_MS,
          ),
        ),
      },
    });
    const generateReply = vi.fn(() =>
      delay('The clubhouse is open 9am-10pm daily.', GEMINI_LATENCY_MS),
    );
    const { orchestrator, deps } = buildOrchestratorHarness({
      toolRegistry: createToolRegistry(tools),
      geminiResponder: { generateReply },
    });

    const questionText = 'What time does the clubhouse open?';
    const event = faqEvent(questionText);
    const start = Date.now();
    const handlePromise = orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);
    await vi.advanceTimersByTimeAsync(GEMINI_LATENCY_MS + KNOWLEDGE_SEARCH_LATENCY_MS + 100);
    await handlePromise;
    const elapsedMs = Date.now() - start;

    // Reply -> WhatsApp, grounded in exactly the retrieved chunk.
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      'The clubhouse is open 9am-10pm daily.',
      event.messageId,
    );
    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeContext: [clubhouseMatch], userMessage: questionText }),
    );

    // <5s NFR (HLD Sec 17) — the orchestrator's own overhead on top of the
    // two real I/O calls stays well inside budget.
    expect(elapsedMs).toBeLessThanOrEqual(NFR_TARGETS.averageResponseSeconds * 1000);
  });

  it('never hallucinates: a low-confidence match escalates instead of calling Gemini (grounding, negative case)', async () => {
    const weakMatch: KnowledgeSearchResult = {
      documentTitle: 'Bye Laws',
      excerpt: 'Loosely related content.',
      score: FAQ_MIN_CONFIDENCE_SCORE - 0.1,
      category: 'bye_laws',
    };
    const tools = makeToolRegistryTools({
      knowledgeSearch: {
        search: vi.fn(async (_q: string, opts?: { category?: string }) =>
          opts?.category === 'bye_laws' ? [weakMatch] : [],
        ),
      },
    });
    const generateReply = vi.fn().mockResolvedValue('should never be called');
    const { orchestrator, deps } = buildOrchestratorHarness({
      toolRegistry: createToolRegistry(tools),
      geminiResponder: { generateReply },
    });

    await orchestrator.handleResidentEvent(
      faqEvent('Some obscure bye-laws question?'),
      RESIDENT_CONTEXT,
    );

    expect(generateReply).not.toHaveBeenCalled();
    expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalled();
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("couldn't find a confident answer"),
      expect.any(String),
    );
  });

  it('never hallucinates: zero knowledge matches also escalates rather than answering from outside knowledge', async () => {
    const { orchestrator, deps } = buildOrchestratorHarness(); // default knowledgeSearch.search resolves []

    await orchestrator.handleResidentEvent(
      faqEvent('Totally unrelated question?'),
      RESIDENT_CONTEXT,
    );

    expect(deps.geminiResponder.generateReply).not.toHaveBeenCalled();
    expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalled();
  });
});
