/**
 * agent/gemini.ts
 *
 * Gemini response generation — the "Gemini" step of the Agent Workflow
 * (HLD Sec 8: Intent Detection -> Tool Selection -> Knowledge Search ->
 * Gemini -> Response). Takes conversation history
 * (memory/conversationStore.ts's `GeminiContent[]`) plus optional retrieved
 * knowledge-base context (tools/knowledgeSearchTool.ts) and produces the
 * reply text gateway/orchestrator.ts sends back to the resident.
 *
 * Same explicit-config convention as tools/whatsappTool.ts and
 * memory/embeddings.ts: no hidden `process.env` reads inside, and
 * `generateImpl` is injectable so gateway/orchestrator.ts can be unit
 * tested without a real Gemini API key or network call.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Env } from '../config/env.js';
import type { GeminiContent } from '../memory/conversationStore.js';
import type { KnowledgeSearchResult } from '../tools/knowledgeSearchTool.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { redactPhoneNumbers } from './piiRedaction.js';

export interface GenerateReplyInput {
  /** Prior turns, oldest first — memory/conversationStore.ts's getRecentHistoryForPrompt(). */
  history: GeminiContent[];
  /** Retrieved knowledge-base chunks to ground the answer in (HLD Sec 6.2, 7.4). */
  knowledgeContext?: KnowledgeSearchResult[];
  userMessage: string;
}

export interface GeminiResponder {
  generateReply(input: GenerateReplyInput): Promise<string>;
}

export interface GeminiResponderConfig {
  apiKey: string;
  model: string;
  /** Injectable for tests — bypasses the real Gemini client entirely. */
  generateImpl?: (args: { history: GeminiContent[]; message: string }) => Promise<string>;
}

/** Builds a GeminiResponderConfig from env — the one place this module reads env. */
export function geminiResponderConfigFromEnv(env: Env): GeminiResponderConfig {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required to create the Gemini responder.');
  }
  return { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL };
}

/**
 * Prefixes the resident's message with retrieved knowledge-base excerpts,
 * numbered so the model can (and per the system prompt, should) decline to
 * answer when none are relevant rather than fall back on general knowledge
 * — the "never hallucinate" guardrail (HLD Sec 16) lives in the prompt text
 * (agent/systemPrompt.ts) and in gateway/orchestrator.ts's confidence check
 * (config/constants.ts FAQ_MIN_CONFIDENCE_SCORE) before this is even called;
 * this is just how the retrieved context is handed over.
 *
 * `userMessage` is redacted (agent/piiRedaction.ts) before being included
 * — HLD Sec 15's "no resident data shared with the LLM unnecessarily": a
 * knowledge-grounded FAQ answer doesn't need the resident's exact wording
 * to contain a phone number for the model to match it against
 * `knowledgeContext` and answer. The unredacted original is still what's
 * sent back over WhatsApp and stored in conversationStore/audit_logs —
 * only the text actually transmitted to Gemini is affected.
 */
function buildMessage(input: GenerateReplyInput): string {
  const redactedMessage = redactPhoneNumbers(input.userMessage);
  if (!input.knowledgeContext?.length) return redactedMessage;

  const context = input.knowledgeContext
    .map((match, i) => `[${i + 1}] (${match.documentTitle}) ${match.excerpt}`)
    .join('\n');

  return `Relevant society documents:\n${context}\n\nResident's message: ${redactedMessage}`;
}

/** Same redaction, applied to prior conversation turns before they become chat history sent to Gemini. */
function redactHistory(history: GeminiContent[]): GeminiContent[] {
  return history.map((turn) => ({
    ...turn,
    parts: turn.parts.map((part) => ({ ...part, text: redactPhoneNumbers(part.text) })),
  }));
}

export function createGeminiResponder(config: GeminiResponderConfig): GeminiResponder {
  return {
    async generateReply(input) {
      const message = buildMessage(input);
      const history = redactHistory(input.history);

      if (config.generateImpl) {
        return config.generateImpl({ history, message });
      }

      const client = new GoogleGenerativeAI(config.apiKey);
      const model = client.getGenerativeModel({
        model: config.model,
        systemInstruction: SYSTEM_PROMPT,
      });
      const chat = model.startChat({ history });
      const result = await chat.sendMessage(message);
      return result.response.text();
    },
  };
}
