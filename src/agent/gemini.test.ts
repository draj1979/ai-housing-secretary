import { describe, expect, it, vi } from 'vitest';
import { createGeminiResponder, geminiResponderConfigFromEnv } from './gemini.js';
import type { Env } from '../config/env.js';
import type { KnowledgeSearchResult } from '../tools/knowledgeSearchTool.js';

describe('createGeminiResponder', () => {
  it('passes history and the raw message through when there is no knowledge context', async () => {
    const generateImpl = vi.fn().mockResolvedValue('Hi there!');
    const responder = createGeminiResponder({
      apiKey: 'k',
      model: 'gemini-flash-lite',
      generateImpl,
    });

    const reply = await responder.generateReply({
      history: [{ role: 'user', parts: [{ text: 'hello' }] }],
      userMessage: 'What are the clubhouse timings?',
    });

    expect(reply).toBe('Hi there!');
    expect(generateImpl).toHaveBeenCalledWith({
      history: [{ role: 'user', parts: [{ text: 'hello' }] }],
      message: 'What are the clubhouse timings?',
    });
  });

  it('prefixes the message with numbered knowledge-base excerpts when context is given', async () => {
    const generateImpl = vi.fn().mockResolvedValue('The clubhouse is open 9am-10pm.');
    const responder = createGeminiResponder({
      apiKey: 'k',
      model: 'gemini-flash-lite',
      generateImpl,
    });

    const knowledgeContext: KnowledgeSearchResult[] = [
      {
        documentTitle: 'Clubhouse Rules',
        excerpt: 'Booking hours: 9:00 AM - 10:00 PM.',
        score: 0.8,
      },
    ];

    await responder.generateReply({
      history: [],
      knowledgeContext,
      userMessage: 'What are the clubhouse timings?',
    });

    const call = generateImpl.mock.calls[0]?.[0];
    expect(call.message).toContain('[1] (Clubhouse Rules) Booking hours: 9:00 AM - 10:00 PM.');
    expect(call.message).toContain("Resident's message: What are the clubhouse timings?");
  });

  it('includes all knowledge matches, numbered in order', async () => {
    const generateImpl = vi.fn().mockResolvedValue('reply');
    const responder = createGeminiResponder({
      apiKey: 'k',
      model: 'gemini-flash-lite',
      generateImpl,
    });

    await responder.generateReply({
      history: [],
      knowledgeContext: [
        { documentTitle: 'Doc A', excerpt: 'excerpt A', score: 0.9 },
        { documentTitle: 'Doc B', excerpt: 'excerpt B', score: 0.7 },
      ],
      userMessage: 'question',
    });

    const message = generateImpl.mock.calls[0]?.[0].message as string;
    expect(message).toContain('[1] (Doc A) excerpt A');
    expect(message).toContain('[2] (Doc B) excerpt B');
  });

  it('redacts phone numbers from userMessage and history before they reach Gemini (HLD Sec 15)', async () => {
    const generateImpl = vi.fn().mockResolvedValue('reply');
    const responder = createGeminiResponder({
      apiKey: 'k',
      model: 'gemini-flash-lite',
      generateImpl,
    });

    await responder.generateReply({
      history: [{ role: 'user', parts: [{ text: 'Call my neighbor at +919820099009.' }] }],
      userMessage: 'My number is +919820011001, please call back.',
    });

    const call = generateImpl.mock.calls[0]?.[0];
    expect(call.message).not.toContain('+919820011001');
    expect(call.message).toContain('[redacted-phone-number]');
    expect(call.history[0].parts[0].text).not.toContain('+919820099009');
    expect(call.history[0].parts[0].text).toContain('[redacted-phone-number]');
  });
});

describe('geminiResponderConfigFromEnv', () => {
  it('throws when GEMINI_API_KEY is missing', () => {
    const env = { GEMINI_MODEL: 'gemini-flash-lite' } as Env;
    expect(() => geminiResponderConfigFromEnv(env)).toThrow(/GEMINI_API_KEY/);
  });

  it('builds a config from env when GEMINI_API_KEY is set', () => {
    const env = { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-flash-lite' } as Env;
    const config = geminiResponderConfigFromEnv(env);
    expect(config).toEqual({ apiKey: 'test-key', model: 'gemini-flash-lite' });
  });
});
