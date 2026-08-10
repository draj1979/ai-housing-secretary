/**
 * tools/suggestionTool.ts
 *
 * Suggestion Management tool (HLD Sec 6.4). Records a resident's
 * suggestion and categorizes it into maintenance / security / amenities /
 * finance (config/constants.ts SUGGESTION_CATEGORIES).
 */
import { suggestions } from '../db/schema.js';
import { getPostgresClient, type Database } from '../memory/postgresAdapter.js';
import { SUGGESTION_CATEGORIES } from '../config/constants.js';

export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];

export interface CreateSuggestionInput {
  residentId: string;
  body: string;
  /** Skips auto-categorization if the caller already knows the category. */
  category?: SuggestionCategory;
}

export interface Suggestion {
  id: string;
  category: SuggestionCategory;
}

export interface SuggestionTool {
  createSuggestion(input: CreateSuggestionInput): Promise<Suggestion>;
}

// Checked in order; first match wins. "maintenance" has no pattern of its
// own — it's the fallback, matching the category residents most commonly
// mean when a suggestion doesn't obviously belong to one of the other three.
const CATEGORY_PATTERNS: ReadonlyArray<{
  category: Exclude<SuggestionCategory, 'maintenance'>;
  pattern: RegExp;
}> = [
  {
    category: 'security',
    pattern: /\b(security|guard|cctv|camera(s)?|watchman|intercom|gate keeper)\b/i,
  },
  {
    category: 'finance',
    pattern:
      /\b(maintenance charge|\bfee(s)?\b|\bfund(s)?\b|budget|expense(s)?|finance|payment|billing)\b/i,
  },
  {
    category: 'amenities',
    pattern: /\b(garden|gym(nasium)?|clubhouse|pool|playground|amenit(y|ies)|terrace|lounge)\b/i,
  },
];

/**
 * Keyword-based categorizer — deterministic and testable without a Gemini
 * call, matching agent/intentRouter.ts's convention. Pure; exported
 * standalone for direct unit testing.
 */
export function categorizeSuggestion(body: string): SuggestionCategory {
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(body)) return category;
  }
  return 'maintenance';
}

export function createSuggestionTool(db: Database = getPostgresClient()): SuggestionTool {
  return {
    async createSuggestion(input) {
      const category = input.category ?? categorizeSuggestion(input.body);

      const [row] = await db
        .insert(suggestions)
        .values({ residentId: input.residentId, category, body: input.body })
        .returning();
      if (!row) throw new Error('Failed to create suggestion.');

      return { id: row.id, category: row.category };
    },
  };
}
