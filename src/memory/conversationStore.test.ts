import { describe, expect, it } from 'vitest';
import {
  clampHistoryWindow,
  DEFAULT_HISTORY_WINDOW,
  MAX_HISTORY_WINDOW,
  toGeminiContents,
  type ConversationMessage,
} from './conversationStore.js';

describe('clampHistoryWindow', () => {
  it('falls back to DEFAULT_HISTORY_WINDOW (20) when no limit is given', () => {
    expect(clampHistoryWindow(undefined)).toBe(DEFAULT_HISTORY_WINDOW);
    expect(DEFAULT_HISTORY_WINDOW).toBe(20);
  });

  it('passes through a valid positive integer', () => {
    expect(clampHistoryWindow(5)).toBe(5);
  });

  it('floors a non-integer limit', () => {
    expect(clampHistoryWindow(5.7)).toBe(5);
  });

  it('falls back for zero, negative, or non-finite limits', () => {
    expect(clampHistoryWindow(0)).toBe(DEFAULT_HISTORY_WINDOW);
    expect(clampHistoryWindow(-10)).toBe(DEFAULT_HISTORY_WINDOW);
    expect(clampHistoryWindow(Number.NaN)).toBe(DEFAULT_HISTORY_WINDOW);
    expect(clampHistoryWindow(Number.POSITIVE_INFINITY)).toBe(DEFAULT_HISTORY_WINDOW);
  });

  it('caps at MAX_HISTORY_WINDOW regardless of what is requested', () => {
    expect(clampHistoryWindow(100_000)).toBe(MAX_HISTORY_WINDOW);
  });

  it('honors a custom fallback', () => {
    expect(clampHistoryWindow(undefined, 5)).toBe(5);
    expect(clampHistoryWindow(-1, 5)).toBe(5);
  });
});

describe('toGeminiContents', () => {
  function msg(overrides: Partial<ConversationMessage>): ConversationMessage {
    return {
      id: 'm1',
      conversationId: 'c1',
      direction: 'in',
      senderType: 'resident',
      body: 'hello',
      mediaUrl: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  it('maps resident messages to the "user" role', () => {
    const [content] = toGeminiContents([
      msg({ senderType: 'resident', body: 'Water leak in A-403' }),
    ]);
    expect(content).toEqual({ role: 'user', parts: [{ text: 'Water leak in A-403' }] });
  });

  it('maps ai messages to the "model" role', () => {
    const [content] = toGeminiContents([
      msg({ senderType: 'ai', direction: 'out', body: 'A ticket has been created.' }),
    ]);
    expect(content).toEqual({ role: 'model', parts: [{ text: 'A ticket has been created.' }] });
  });

  it('maps secretary messages to "user" with a [Secretary]: prefix', () => {
    const [content] = toGeminiContents([
      msg({ senderType: 'secretary', direction: 'out', body: 'This is being handled.' }),
    ]);
    expect(content).toEqual({
      role: 'user',
      parts: [{ text: '[Secretary]: This is being handled.' }],
    });
  });

  it('preserves message order (oldest first in, oldest first out)', () => {
    const messages = [
      msg({ id: '1', body: 'first' }),
      msg({ id: '2', senderType: 'ai', body: 'second' }),
      msg({ id: '3', body: 'third' }),
    ];
    const contents = toGeminiContents(messages);
    expect(contents.map((c) => c.parts[0]?.text)).toEqual(['first', 'second', 'third']);
  });

  it('returns an empty array for no history', () => {
    expect(toGeminiContents([])).toEqual([]);
  });
});
