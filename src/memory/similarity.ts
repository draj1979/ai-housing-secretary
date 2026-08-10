/**
 * memory/similarity.ts
 *
 * Pure vector-similarity utilities shared by memory/vectorStore.ts's
 * InMemoryVectorStore (used in tests, see vectorStore.test.ts) and by
 * PgVectorStore/ChromaVectorStore's score normalization — both real
 * backends expose scores on the same "higher is more similar" cosine scale
 * computed here, so callers don't need to know which provider answered.
 */

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}.`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface ScoredMatch<T> {
  item: T;
  score: number;
}

interface Candidate<T> {
  item: T;
  embedding: readonly number[];
}

/**
 * Ranks candidates by cosine similarity to `queryEmbedding` and returns the
 * top `topK`, highest score first. `topK <= 0` returns an empty array.
 */
export function rankTopK<T>(
  candidates: readonly Candidate<T>[],
  queryEmbedding: readonly number[],
  topK: number,
): ScoredMatch<T>[] {
  if (topK <= 0) return [];

  return candidates
    .map(({ item, embedding }) => ({ item, score: cosineSimilarity(embedding, queryEmbedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
