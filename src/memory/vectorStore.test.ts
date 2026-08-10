import { describe, expect, it } from 'vitest';
import { InMemoryVectorStore, type KnowledgeChunkInput } from './vectorStore.js';

/**
 * Exercises the `VectorStore` contract end to end (upsert -> query with
 * top-k similarity search) against `InMemoryVectorStore` — the same
 * interface `PgVectorStore` and `ChromaVectorStore` implement against real
 * infrastructure, but testable here without a database or network.
 */
describe('InMemoryVectorStore (top-k similarity search)', () => {
  function chunk(
    documentId: string,
    chunkIndex: number,
    embedding: number[],
    overrides: Partial<KnowledgeChunkInput> = {},
  ): KnowledgeChunkInput {
    return {
      documentId,
      chunkIndex,
      content: `${documentId}#${chunkIndex}`,
      embedding,
      ...overrides,
    };
  }

  it('returns the closest chunks first, ranked by cosine similarity', async () => {
    const store = new InMemoryVectorStore();
    await store.upsertChunks([
      chunk('parking-policy', 0, [1, 0, 0], { category: 'parking_policy' }),
      chunk('bye-laws', 0, [0, 1, 0], { category: 'bye_laws' }),
      chunk('clubhouse-rules', 0, [0.9, 0.1, 0], { category: 'clubhouse_rules' }),
    ]);

    const results = await store.query([1, 0, 0], 3);

    expect(results.map((r) => r.documentId)).toEqual([
      'parking-policy',
      'clubhouse-rules',
      'bye-laws',
    ]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? Infinity);
    expect(results[1]?.score).toBeGreaterThan(results[2]?.score ?? Infinity);
  });

  it('limits results to topK', async () => {
    const store = new InMemoryVectorStore();
    await store.upsertChunks([
      chunk('doc-a', 0, [1, 0]),
      chunk('doc-b', 0, [0.8, 0.2]),
      chunk('doc-c', 0, [0.5, 0.5]),
      chunk('doc-d', 0, [0, 1]),
    ]);

    const results = await store.query([1, 0], 2);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.documentId)).toEqual(['doc-a', 'doc-b']);
  });

  it('filters by category when requested', async () => {
    const store = new InMemoryVectorStore();
    await store.upsertChunks([
      chunk('parking-policy', 0, [1, 0, 0], { category: 'parking_policy' }),
      chunk('maintenance-rules', 0, [0.99, 0.01, 0], { category: 'maintenance_rules' }),
    ]);

    const results = await store.query([1, 0, 0], 5, { category: 'maintenance_rules' });

    expect(results).toHaveLength(1);
    expect(results[0]?.documentId).toBe('maintenance-rules');
  });

  it('replaces a chunk on upsert with the same documentId + chunkIndex instead of duplicating it', async () => {
    const store = new InMemoryVectorStore();
    await store.upsertChunks([chunk('doc-a', 0, [1, 0], { content: 'old content' })]);
    await store.upsertChunks([chunk('doc-a', 0, [1, 0], { content: 'new content' })]);

    const results = await store.query([1, 0], 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('new content');
  });

  it('removes all chunks for a document on deleteDocumentChunks, leaving others intact', async () => {
    const store = new InMemoryVectorStore();
    await store.upsertChunks([
      chunk('doc-a', 0, [1, 0]),
      chunk('doc-a', 1, [0.9, 0.1]),
      chunk('doc-b', 0, [0, 1]),
    ]);

    await store.deleteDocumentChunks('doc-a');
    const results = await store.query([1, 0], 5);

    expect(results.map((r) => r.documentId)).toEqual(['doc-b']);
  });

  it('returns an empty array when the store has no chunks', async () => {
    const store = new InMemoryVectorStore();
    expect(await store.query([1, 0, 0], 5)).toEqual([]);
  });

  it('carries chunk metadata through to search results', async () => {
    const store = new InMemoryVectorStore();
    await store.upsertChunks([
      chunk('doc-a', 0, [1, 0], { metadata: { title: 'Parking Policy', startOffset: 0 } }),
    ]);

    const [result] = await store.query([1, 0], 1);
    expect(result?.metadata).toEqual({ title: 'Parking Policy', startOffset: 0 });
  });
});
