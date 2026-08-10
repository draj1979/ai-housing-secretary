import { describe, expect, it } from 'vitest';
import { cosineSimilarity, rankTopK } from './similarity.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  it('is invariant to vector magnitude (only direction matters)', () => {
    const a = [1, 2, 3];
    const scaled = [2, 4, 6];
    const b = [3, -1, 2];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(scaled, b), 10);
  });

  it('returns 0 for a zero vector rather than NaN', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('throws on mismatched dimensions', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });
});

describe('rankTopK', () => {
  const candidates = [
    { item: 'parking-policy', embedding: [1, 0, 0] },
    { item: 'bye-laws', embedding: [0, 1, 0] },
    { item: 'clubhouse-rules', embedding: [0.9, 0.1, 0] }, // close to query
    { item: 'emergency-contacts', embedding: [-1, 0, 0] }, // opposite of query
  ];

  it('ranks candidates by descending similarity to the query', () => {
    const query = [1, 0, 0];
    const results = rankTopK(candidates, query, 4);

    expect(results.map((r) => r.item)).toEqual([
      'parking-policy',
      'clubhouse-rules',
      'bye-laws',
      'emergency-contacts',
    ]);
    // scores are non-increasing
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  });

  it('respects topK, returning only the best K matches', () => {
    const results = rankTopK(candidates, [1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.item)).toEqual(['parking-policy', 'clubhouse-rules']);
  });

  it('returns an empty array when topK is 0 or negative', () => {
    expect(rankTopK(candidates, [1, 0, 0], 0)).toEqual([]);
    expect(rankTopK(candidates, [1, 0, 0], -5)).toEqual([]);
  });

  it('returns an empty array for an empty candidate set', () => {
    expect(rankTopK([], [1, 0, 0], 5)).toEqual([]);
  });

  it('caps at the number of available candidates when topK exceeds it', () => {
    const results = rankTopK(candidates, [1, 0, 0], 100);
    expect(results).toHaveLength(candidates.length);
  });

  it('attaches the correct cosine score to each item', () => {
    const results = rankTopK(candidates, [1, 0, 0], 1);
    expect(results[0]?.item).toBe('parking-policy');
    expect(results[0]?.score).toBeCloseTo(1, 10);
  });
});
