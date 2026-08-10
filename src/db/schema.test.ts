import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { ESCALATION_CATEGORIES, SUGGESTION_CATEGORIES } from '../config/constants.js';
import { EMBEDDING_DIMENSIONS } from '../memory/embeddings.js';
import {
  announcements,
  auditLogs,
  complaints,
  conversations,
  escalationCategoryEnum,
  escalations,
  knowledgeChunks,
  knowledgeDocuments,
  messages,
  residents,
  suggestionCategoryEnum,
  suggestions,
} from './schema.js';

describe('schema', () => {
  it('keeps suggestion_category enum in sync with config/constants.ts SUGGESTION_CATEGORIES', () => {
    // schema.ts cannot import config/constants.ts directly (drizzle-kit's CJS
    // schema loader can't resolve the cross-file ESM import) so the enum
    // values are duplicated there — this test guards against drift.
    expect([...suggestionCategoryEnum.enumValues]).toEqual([...SUGGESTION_CATEGORIES]);
  });

  it('keeps escalation_category enum in sync with config/constants.ts ESCALATION_CATEGORIES', () => {
    expect([...escalationCategoryEnum.enumValues]).toEqual([...ESCALATION_CATEGORIES]);
  });

  it('keeps knowledge_chunks.embedding dimensions in sync with memory/embeddings.ts EMBEDDING_DIMENSIONS', () => {
    // Same drizzle-kit CJS-loader constraint as above — db/schema.ts
    // hardcodes its own copy of this number rather than importing it.
    const embeddingColumn = getTableConfig(knowledgeChunks).columns.find(
      (c) => c.name === 'embedding',
    );
    expect(embeddingColumn?.getSQLType()).toBe(`vector(${EMBEDDING_DIMENSIONS})`);
  });

  it('defines the required indexes for polling/lookup columns', () => {
    const complaintsIndexes = getTableConfig(complaints).indexes.map((i) => i.config.name);
    expect(complaintsIndexes).toContain('complaints_ticket_id_idx');
    expect(complaintsIndexes).toContain('complaints_status_idx');

    const residentsIndexes = getTableConfig(residents).indexes.map((i) => i.config.name);
    expect(residentsIndexes).toContain('residents_phone_e164_hash_idx');

    const escalationsIndexes = getTableConfig(escalations).indexes.map((i) => i.config.name);
    expect(escalationsIndexes).toContain('escalations_status_idx');

    const announcementsIndexes = getTableConfig(announcements).indexes.map((i) => i.config.name);
    expect(announcementsIndexes).toContain('announcements_status_idx');
  });

  it('defines the knowledge_chunks table with a unique (document_id, chunk_index) and category index', () => {
    const indexes = getTableConfig(knowledgeChunks).indexes.map((i) => i.config.name);
    expect(indexes).toContain('knowledge_chunks_document_chunk_idx');
    expect(indexes).toContain('knowledge_chunks_document_id_idx');
    expect(indexes).toContain('knowledge_chunks_category_idx');
  });

  it('exposes all ten tables required by the HLD (including knowledge_chunks for the vector store)', () => {
    const tables = [
      residents,
      conversations,
      messages,
      complaints,
      suggestions,
      announcements,
      escalations,
      knowledgeDocuments,
      knowledgeChunks,
      auditLogs,
    ];
    expect(tables).toHaveLength(10);
    for (const table of tables) {
      expect(getTableConfig(table).name).toBeTruthy();
    }
  });
});
