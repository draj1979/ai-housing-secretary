import { describe, expect, it, vi } from 'vitest';
import { createFaqModule, FAQ_KNOWLEDGE_CATEGORIES, type FaqModuleDeps } from './faq.js';
import type { KnowledgeSearchResult } from '../tools/knowledgeSearchTool.js';

const CONTEXT = { sourceType: 'query' as const, sourceId: 'session-1' };

function match(
  category: string,
  score: number,
  excerpt = `${category} excerpt`,
): KnowledgeSearchResult {
  return { documentTitle: `${category} doc`, excerpt, score, category };
}

function makeDeps(overrides: Partial<FaqModuleDeps> = {}): FaqModuleDeps {
  return {
    knowledgeSearch: { search: vi.fn().mockResolvedValue([]) },
    geminiResponder: { generateReply: vi.fn().mockResolvedValue('Gemini answer.') },
    escalationModule: {
      escalate: vi.fn().mockResolvedValue({
        escalationId: 'e1234567-aaaa-bbbb-cccc-000000000000',
        category: 'unknown_question',
        replyText:
          "I couldn't find a confident answer to that in our records, so I've forwarded your question to the Secretary (ref: e1234567).",
      }),
    },
    ...overrides,
  };
}

describe('FAQ_KNOWLEDGE_CATEGORIES', () => {
  it('covers exactly the four HLD Sec 6.2 categories', () => {
    expect([...FAQ_KNOWLEDGE_CATEGORIES].sort()).toEqual(
      ['bye_laws', 'clubhouse_rules', 'maintenance_rules', 'parking_policy'].sort(),
    );
  });
});

describe('createFaqModule > answerQuestion', () => {
  it('searches every FAQ category and answers via Gemini when there is a confident match', async () => {
    const search = vi.fn(async (_q: string, opts?: { category?: string }) =>
      opts?.category === 'parking_policy' ? [match('parking_policy', 0.82)] : [],
    );
    const deps = makeDeps({ knowledgeSearch: { search } });
    const faq = createFaqModule(deps);

    const result = await faq.answerQuestion('Where can I park my second car?', [], CONTEXT);

    // Queried all four categories, not just the one with a hit.
    expect(search).toHaveBeenCalledTimes(FAQ_KNOWLEDGE_CATEGORIES.length);
    for (const category of FAQ_KNOWLEDGE_CATEGORIES) {
      expect(search).toHaveBeenCalledWith('Where can I park my second car?', {
        topK: 3,
        category,
      });
    }

    expect(result.answered).toBe(true);
    expect(result.replyText).toBe('Gemini answer.');
    expect(result.matches).toEqual([match('parking_policy', 0.82)]);
    expect(result.escalationId).toBeUndefined();
    expect(deps.escalationModule.escalate).not.toHaveBeenCalled();
  });

  it('grounds Gemini only in the retrieved chunks — no outside knowledge is passed', async () => {
    const topMatch = match('bye_laws', 0.7, 'Transfers require a 15-day notice.');
    const deps = makeDeps({
      knowledgeSearch: {
        search: vi.fn(async (_q: string, opts?: { category?: string }) =>
          opts?.category === 'bye_laws' ? [topMatch] : [],
        ),
      },
    });
    const faq = createFaqModule(deps);
    const history = [{ role: 'user' as const, parts: [{ text: 'earlier turn' }] }];

    await faq.answerQuestion('How do I transfer my flat?', history, CONTEXT);

    expect(deps.geminiResponder.generateReply).toHaveBeenCalledWith({
      history,
      knowledgeContext: [topMatch],
      userMessage: 'How do I transfer my flat?',
    });
  });

  it('merges and sorts matches across categories by score, capped at topK', async () => {
    const search = vi.fn(async (_q: string, opts?: { category?: string; topK?: number }) => {
      switch (opts?.category) {
        case 'bye_laws':
          return [match('bye_laws', 0.4)];
        case 'maintenance_rules':
          return [match('maintenance_rules', 0.9)];
        case 'parking_policy':
          return [match('parking_policy', 0.6)];
        case 'clubhouse_rules':
          return [match('clubhouse_rules', 0.75)];
        default:
          return [];
      }
    });
    const deps = makeDeps({ knowledgeSearch: { search } });
    const faq = createFaqModule({ ...deps, topK: 3 });

    const result = await faq.answerQuestion('General question', [], CONTEXT);

    expect(result.matches.map((m) => m.category)).toEqual([
      'maintenance_rules',
      'clubhouse_rules',
      'parking_policy',
    ]);
    expect(result.matches).toHaveLength(3);
  });

  it('escalates as unknown_answer instead of calling Gemini when nothing matches at all', async () => {
    const deps = makeDeps(); // default search resolves []
    const faq = createFaqModule(deps);

    const result = await faq.answerQuestion('Some obscure question.', [], CONTEXT);

    expect(result.answered).toBe(false);
    expect(result.escalationId).toBe('e1234567-aaaa-bbbb-cccc-000000000000');
    expect(result.replyText).toContain("couldn't find a confident answer");
    expect(deps.escalationModule.escalate).toHaveBeenCalledWith({
      sourceType: 'query',
      sourceId: 'session-1',
      reason: 'unknown_answer: Some obscure question.',
      message: 'Some obscure question.',
    });
    expect(deps.geminiResponder.generateReply).not.toHaveBeenCalled();
  });

  it('escalates instead of answering when the best match is below the confidence threshold', async () => {
    const deps = makeDeps({
      knowledgeSearch: { search: vi.fn().mockResolvedValue([match('bye_laws', 0.2)]) },
    });
    const faq = createFaqModule(deps);

    const result = await faq.answerQuestion('Vague question.', [], CONTEXT);

    expect(result.answered).toBe(false);
    expect(deps.geminiResponder.generateReply).not.toHaveBeenCalled();
    expect(deps.escalationModule.escalate).toHaveBeenCalled();
  });

  it('answers when the score is exactly at the confidence threshold (inclusive)', async () => {
    const deps = makeDeps({
      knowledgeSearch: { search: vi.fn().mockResolvedValue([match('bye_laws', 0.5)]) },
    });
    const faq = createFaqModule(deps); // default threshold 0.5

    const result = await faq.answerQuestion('Borderline question.', [], CONTEXT);

    expect(result.answered).toBe(true);
    expect(deps.escalationModule.escalate).not.toHaveBeenCalled();
  });

  it('respects a custom minConfidenceScore override', async () => {
    const deps = makeDeps({
      knowledgeSearch: { search: vi.fn().mockResolvedValue([match('bye_laws', 0.6)]) },
      minConfidenceScore: 0.9, // stricter than the 0.6 match
    });
    const faq = createFaqModule(deps);

    const result = await faq.answerQuestion('Question.', [], CONTEXT);

    expect(result.answered).toBe(false);
  });

  it('respects a custom topK override for both per-category and merged results', async () => {
    const search = vi.fn().mockResolvedValue([match('x', 0.9), match('x', 0.8)]);
    const deps = makeDeps({ knowledgeSearch: { search }, topK: 1 });
    const faq = createFaqModule(deps);

    await faq.answerQuestion('Question.', [], CONTEXT);

    expect(search).toHaveBeenCalledWith('Question.', expect.objectContaining({ topK: 1 }));
  });
});
