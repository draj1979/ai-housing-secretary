/**
 * modules/faq.ts
 *
 * FAQ Assistant (HLD Sec 6.2, 10): on a tagged/mentioned message to the
 * public AI Secretary number, search the knowledge base
 * (memory/vectorStore.ts via tools/knowledgeSearchTool.ts), build a
 * grounded answer via Gemini using *only* the retrieved chunks, and reply.
 * If retrieval confidence is below threshold, don't answer — route to
 * escalation instead (agent/escalation.ts's `escalateUnknownAnswer`, HLD
 * Sec 16 "unknown answers").
 *
 * This module assumes the caller (gateway/orchestrator.ts) has already
 * established that the message arrived on the AI number and isn't one of
 * the mandatory-escalation/forbidden-action cases — it's the "search then
 * answer" step specifically, not the whole resident pipeline.
 *
 * Grounding: agent/gemini.ts's `generateReply` only ever answers from the
 * `knowledgeContext` chunks passed to it (agent/systemPrompt.ts explicitly
 * forbids filling gaps from general knowledge) — this module is what makes
 * sure that context is never empty/weak when Gemini is called at all; see
 * the confidence gate below.
 */
import type { GeminiResponder } from '../agent/gemini.js';
import { escalateUnknownAnswer, type EscalationContext } from '../agent/escalation.js';
import type { GeminiContent } from '../memory/conversationStore.js';
import type { KnowledgeSearchResult, KnowledgeSearchTool } from '../tools/knowledgeSearchTool.js';
import type { EscalationModule } from './escalation.js';
import { FAQ_MIN_CONFIDENCE_SCORE } from '../config/constants.js';

/**
 * The four knowledge-base categories HLD Sec 6.2 names for the FAQ
 * Assistant specifically — Society Rules, Maintenance Policy, Parking
 * Rules, Clubhouse Rules — mapped to the category slugs
 * scripts/ingest-knowledge.ts writes (db/schema.ts's knowledge_documents
 * comment). Deliberately narrower than the full six-category knowledge
 * base from HLD Sec 7.4: Emergency Contacts isn't a "frequently asked
 * question" in the same sense (residents shouldn't get contact numbers
 * filtered through a similarity search when they need them fast — see
 * docs/knowledge/emergency-contacts.md's own note on this), and the
 * Society Handbook is general orientation content rather than a rules
 * document this assistant is meant to answer from. If that interpretation
 * turns out wrong in practice, widen this list — it's the one place that
 * scoping decision lives.
 */
export const FAQ_KNOWLEDGE_CATEGORIES = [
  'bye_laws', // "Society Rules"
  'maintenance_rules', // "Maintenance Policy"
  'parking_policy', // "Parking Rules"
  'clubhouse_rules', // "Clubhouse Rules"
] as const;

const DEFAULT_TOP_K = 3;

export interface FaqModuleDeps {
  knowledgeSearch: Pick<KnowledgeSearchTool, 'search'>;
  geminiResponder: Pick<GeminiResponder, 'generateReply'>;
  escalationModule: Pick<EscalationModule, 'escalate'>;
  /** Overrides config/constants.ts FAQ_MIN_CONFIDENCE_SCORE — mainly for tests. */
  minConfidenceScore?: number;
  /** Chunks to retrieve overall (merged across the four categories). Default 3. */
  topK?: number;
}

export interface FaqAnswerResult {
  replyText: string;
  /** `true` if Gemini answered from retrieved chunks; `false` if this escalated instead (HLD Sec 16). */
  answered: boolean;
  /** The chunks retrieval found, in relevance order — `[]` when nothing matched at all. */
  matches: KnowledgeSearchResult[];
  /** Set only when `answered` is `false`. */
  escalationId?: string;
}

export interface FaqModule {
  /**
   * Searches the FAQ knowledge categories, and either replies with a
   * Gemini-generated, chunk-grounded answer (confidence gate cleared) or
   * escalates as `unknown_answer` and replies saying so (gate not cleared).
   * Never both, and never a Gemini call on a weak/empty match.
   */
  answerQuestion(
    question: string,
    history: GeminiContent[],
    escalationContext: EscalationContext,
  ): Promise<FaqAnswerResult>;
}

/**
 * Runs one search per FAQ_KNOWLEDGE_CATEGORIES entry (so a strong match in
 * one category can't be crowded out by weaker matches from the others
 * dominating an unscoped top-k), merges, and keeps the overall top `topK`
 * by score.
 */
async function searchFaqKnowledgeBase(
  question: string,
  knowledgeSearch: Pick<KnowledgeSearchTool, 'search'>,
  topK: number,
): Promise<KnowledgeSearchResult[]> {
  const perCategoryResults = await Promise.all(
    FAQ_KNOWLEDGE_CATEGORIES.map((category) =>
      knowledgeSearch.search(question, { topK, category }),
    ),
  );

  return perCategoryResults
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function createFaqModule(deps: FaqModuleDeps): FaqModule {
  const minConfidenceScore = deps.minConfidenceScore ?? FAQ_MIN_CONFIDENCE_SCORE;
  const topK = deps.topK ?? DEFAULT_TOP_K;

  return {
    async answerQuestion(question, history, escalationContext) {
      const matches = await searchFaqKnowledgeBase(question, deps.knowledgeSearch, topK);
      const topScore = matches[0]?.score ?? -Infinity;

      if (matches.length === 0 || topScore < minConfidenceScore) {
        // Guardrail (HLD Sec 16 "unknown answers"): never let Gemini
        // improvise from a weak or missing match — escalate instead.
        const outcome = await escalateUnknownAnswer(
          question,
          escalationContext,
          deps.escalationModule,
        );
        return {
          replyText: outcome.replyText,
          answered: false,
          matches,
          escalationId: outcome.escalationId,
        };
      }

      const replyText = await deps.geminiResponder.generateReply({
        history,
        knowledgeContext: matches,
        userMessage: question,
      });

      return { replyText, answered: true, matches };
    },
  };
}
