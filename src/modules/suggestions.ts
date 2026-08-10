/**
 * modules/suggestions.ts
 *
 * Suggestion Management (HLD Sec 6.4): classify a resident's suggestion
 * into maintenance / security / amenities / finance using Gemini with a
 * *constrained-output* prompt — the model is given a `responseSchema` with
 * an `enum` of exactly the four categories, so the API itself can only
 * return one of them, never free text (this is a schema constraint
 * enforced by the Gemini API, not just an instruction the model might
 * ignore) — store it via tools/suggestionTool.ts, and send a brief
 * acknowledgement to the resident.
 *
 * If the Gemini call fails (network error, missing/invalid key), this
 * falls back to tools/suggestionTool.ts's keyword-based
 * `categorizeSuggestion` rather than losing the suggestion — a suggestion
 * is low-stakes (unlike agent/guardrails.ts's forbidden-action checks), so
 * "categorized slightly less precisely" beats "not recorded at all".
 */
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import type { Env } from '../config/env.js';
import { SUGGESTION_CATEGORIES } from '../config/constants.js';
import type { AuditLogWriter } from '../agent/guardrails.js';
import {
  categorizeSuggestion,
  type Suggestion,
  type SuggestionCategory,
  type SuggestionTool,
} from '../tools/suggestionTool.js';

// ---------------------------------------------------------------------------
// Classification (Gemini, constrained output)
// ---------------------------------------------------------------------------

export interface SuggestionClassifier {
  classify(body: string): Promise<SuggestionCategory>;
}

export interface SuggestionClassifierConfig {
  apiKey: string;
  model: string;
  /** Injectable for tests — bypasses the real Gemini client entirely. */
  classifyImpl?: (body: string) => Promise<string>;
}

/** Builds a SuggestionClassifierConfig from env — the one place this module reads env. */
export function suggestionClassifierConfigFromEnv(env: Env): SuggestionClassifierConfig {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required to classify suggestions.');
  }
  return { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL };
}

const CLASSIFICATION_PROMPT = `You are classifying a housing society resident's suggestion into exactly one category.

Categories:
- maintenance: repairs, upkeep, cleaning, building or common-area condition
- security: guards, CCTV, gates, access control, safety
- amenities: clubhouse, gym, garden, pool, playground, shared facilities
- finance: maintenance charges, fees, budget, billing, funds

Suggestion: `;

function isSuggestionCategory(value: string): value is SuggestionCategory {
  return (SUGGESTION_CATEGORIES as readonly string[]).includes(value);
}

/**
 * `responseMimeType: 'application/json'` + a STRING `enum` schema means
 * Gemini's response is a JSON-encoded string, e.g. `"security"` (with the
 * quotes) — parse it as JSON first, falling back to a plain trim in case a
 * model/SDK version ever returns the bare token instead.
 */
function parseClassifierOutput(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // fall through to plain-text handling below
  }
  return raw.trim();
}

async function classifyWithGemini(
  config: SuggestionClassifierConfig,
  body: string,
): Promise<string> {
  const client = new GoogleGenerativeAI(config.apiKey);
  const model = client.getGenerativeModel({
    model: config.model,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.STRING,
        enum: [...SUGGESTION_CATEGORIES],
      },
    },
  });
  const result = await model.generateContent(CLASSIFICATION_PROMPT + body);
  return result.response.text();
}

/**
 * Classifies suggestion text into one of `SUGGESTION_CATEGORIES` via
 * Gemini's constrained output. If the model (implausibly, given the schema
 * constraint) or a test double returns something outside the four
 * categories, falls back to `'maintenance'` — the same default
 * `tools/suggestionTool.ts`'s keyword classifier uses — rather than
 * propagating a category the `suggestion_category` Postgres enum would
 * reject.
 */
export function createSuggestionClassifier(
  config: SuggestionClassifierConfig,
): SuggestionClassifier {
  return {
    async classify(body) {
      const raw = config.classifyImpl
        ? await config.classifyImpl(body)
        : await classifyWithGemini(config, body);

      const candidate = parseClassifierOutput(raw);
      return isSuggestionCategory(candidate) ? candidate : 'maintenance';
    },
  };
}

// ---------------------------------------------------------------------------
// The module: classify -> store -> acknowledge
// ---------------------------------------------------------------------------

export interface SubmitSuggestionInput {
  residentId: string;
  body: string;
}

export interface SuggestionOutcome {
  replyText: string;
  suggestion: Suggestion;
  /** `true` if Gemini classified it; `false` if the keyword fallback ran because the Gemini call failed. */
  classifiedByGemini: boolean;
}

export interface SuggestionModuleDeps {
  classifier: Pick<SuggestionClassifier, 'classify'>;
  suggestionTool: Pick<SuggestionTool, 'createSuggestion'>;
  /** Writes the audit_logs row for a filed suggestion (HLD Sec 15 — "every tool call that touches resident data"). */
  auditLog: Pick<AuditLogWriter, 'logAction'>;
}

export interface SuggestionModule {
  submitSuggestion(input: SubmitSuggestionInput): Promise<SuggestionOutcome>;
}

export function createSuggestionModule(deps: SuggestionModuleDeps): SuggestionModule {
  return {
    async submitSuggestion(input) {
      let category: SuggestionCategory;
      let classifiedByGemini = true;
      try {
        category = await deps.classifier.classify(input.body);
      } catch {
        category = categorizeSuggestion(input.body);
        classifiedByGemini = false;
      }

      const suggestion = await deps.suggestionTool.createSuggestion({
        residentId: input.residentId,
        body: input.body,
        category,
      });

      await deps.auditLog.logAction({
        actorType: 'resident',
        actorId: input.residentId,
        action: 'suggestion_created',
        entity: 'suggestion',
        entityId: suggestion.id,
        metadata: { category: suggestion.category, classifiedByGemini },
      });

      return {
        suggestion,
        classifiedByGemini,
        replyText: `Thanks for the suggestion! I've recorded it under "${suggestion.category}" for the Committee to review.`,
      };
    },
  };
}
