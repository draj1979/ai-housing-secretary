import { describe, expect, it } from 'vitest';
import { isKnowledgeCategoryId, KNOWLEDGE_CATEGORIES } from './documents.js';

describe('KNOWLEDGE_CATEGORIES', () => {
  it('has the six HLD Sec 7.4 categories', () => {
    expect(KNOWLEDGE_CATEGORIES.map((c) => c.id).sort()).toEqual(
      [
        'bye_laws',
        'clubhouse_rules',
        'emergency_contacts',
        'handbook',
        'maintenance_rules',
        'parking_policy',
      ].sort(),
    );
  });
});

describe('isKnowledgeCategoryId', () => {
  it('accepts every real category id', () => {
    for (const { id } of KNOWLEDGE_CATEGORIES) {
      expect(isKnowledgeCategoryId(id)).toBe(true);
    }
  });

  it('rejects an unknown category', () => {
    expect(isKnowledgeCategoryId('not_a_category')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isKnowledgeCategoryId(undefined)).toBe(false);
    expect(isKnowledgeCategoryId(null)).toBe(false);
    expect(isKnowledgeCategoryId(42)).toBe(false);
  });
});
