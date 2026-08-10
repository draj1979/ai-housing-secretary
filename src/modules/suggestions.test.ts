import { describe, expect, it, vi } from 'vitest';
import {
  createSuggestionClassifier,
  createSuggestionModule,
  suggestionClassifierConfigFromEnv,
  type SuggestionModuleDeps,
} from './suggestions.js';
import type { Env } from '../config/env.js';
import type { Suggestion } from '../tools/suggestionTool.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-test-model',
    ...overrides,
  } as Env;
}

describe('suggestionClassifierConfigFromEnv', () => {
  it('builds a config from env', () => {
    const config = suggestionClassifierConfigFromEnv(makeEnv());
    expect(config).toEqual({ apiKey: 'test-key', model: 'gemini-test-model' });
  });

  it('throws when GEMINI_API_KEY is missing', () => {
    expect(() => suggestionClassifierConfigFromEnv(makeEnv({ GEMINI_API_KEY: '' }))).toThrow(
      /GEMINI_API_KEY/,
    );
  });
});

describe('createSuggestionClassifier', () => {
  it.each([
    ['maintenance', '"maintenance"'],
    ['security', '"security"'],
    ['amenities', '"amenities"'],
    ['finance', '"finance"'],
  ] as const)('classifies %s from a JSON-quoted Gemini response', async (expected, raw) => {
    const classifier = createSuggestionClassifier({
      apiKey: 'k',
      model: 'm',
      classifyImpl: vi.fn().mockResolvedValue(raw),
    });
    await expect(classifier.classify('some suggestion text')).resolves.toBe(expected);
  });

  it('falls back to maintenance when the model returns an out-of-enum value', async () => {
    const classifier = createSuggestionClassifier({
      apiKey: 'k',
      model: 'm',
      classifyImpl: vi.fn().mockResolvedValue('"not-a-real-category"'),
    });
    await expect(classifier.classify('some suggestion text')).resolves.toBe('maintenance');
  });

  it('falls back to maintenance when the response is not valid JSON but still matches plain text', async () => {
    const classifier = createSuggestionClassifier({
      apiKey: 'k',
      model: 'm',
      classifyImpl: vi.fn().mockResolvedValue('security'),
    });
    // plain unquoted text is handled by the trim fallback in parseClassifierOutput
    await expect(classifier.classify('some suggestion text')).resolves.toBe('security');
  });

  it('passes the suggestion body through to classifyImpl', async () => {
    const classifyImpl = vi.fn().mockResolvedValue('"finance"');
    const classifier = createSuggestionClassifier({ apiKey: 'k', model: 'm', classifyImpl });
    await classifier.classify('Please review the maintenance fee structure');
    expect(classifyImpl).toHaveBeenCalledWith('Please review the maintenance fee structure');
  });
});

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return { id: 'suggestion-1', category: 'maintenance', ...overrides };
}

function makeDeps(overrides: Partial<SuggestionModuleDeps> = {}): SuggestionModuleDeps {
  return {
    classifier: { classify: vi.fn().mockResolvedValue('maintenance') },
    suggestionTool: { createSuggestion: vi.fn().mockResolvedValue(makeSuggestion()) },
    auditLog: { logAction: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('createSuggestionModule', () => {
  it('classifies, stores, and acknowledges a suggestion', async () => {
    const suggestionTool = {
      createSuggestion: vi.fn().mockResolvedValue(makeSuggestion({ category: 'security' })),
    };
    const classifier = { classify: vi.fn().mockResolvedValue('security') };
    const module = createSuggestionModule(makeDeps({ classifier, suggestionTool }));

    const outcome = await module.submitSuggestion({
      residentId: 'resident-1',
      body: 'Please add CCTV at the main gate',
    });

    expect(classifier.classify).toHaveBeenCalledWith('Please add CCTV at the main gate');
    expect(suggestionTool.createSuggestion).toHaveBeenCalledWith({
      residentId: 'resident-1',
      body: 'Please add CCTV at the main gate',
      category: 'security',
    });
    expect(outcome).toEqual({
      suggestion: makeSuggestion({ category: 'security' }),
      classifiedByGemini: true,
      replyText:
        'Thanks for the suggestion! I\'ve recorded it under "security" for the Committee to review.',
    });
  });

  it('falls back to the keyword classifier when Gemini classification fails, without losing the suggestion', async () => {
    const suggestionTool = {
      createSuggestion: vi.fn().mockResolvedValue(makeSuggestion({ category: 'amenities' })),
    };
    const classifier = { classify: vi.fn().mockRejectedValue(new Error('Gemini unavailable')) };
    const module = createSuggestionModule(makeDeps({ classifier, suggestionTool }));

    const outcome = await module.submitSuggestion({
      residentId: 'resident-1',
      body: 'We should build a new clubhouse and gym',
    });

    // tools/suggestionTool.ts's categorizeSuggestion matches "gym" -> amenities
    expect(suggestionTool.createSuggestion).toHaveBeenCalledWith({
      residentId: 'resident-1',
      body: 'We should build a new clubhouse and gym',
      category: 'amenities',
    });
    expect(outcome.classifiedByGemini).toBe(false);
    expect(outcome.suggestion.category).toBe('amenities');
  });
});
