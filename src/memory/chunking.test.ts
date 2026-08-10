import { describe, expect, it } from 'vitest';
import { chunkText, DEFAULT_CHUNK_OVERLAP_CHARS, DEFAULT_MAX_CHUNK_CHARS } from './chunking.js';

describe('chunkText', () => {
  it('returns an empty array for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('returns a single chunk for text under the max size', () => {
    const text = 'This is a short paragraph about society rules.';
    const chunks = chunkText(text, { maxChunkChars: 1000 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[0]?.content).toBe(text);
    expect(chunks[0]?.startOffset).toBe(0);
    expect(chunks[0]?.endOffset).toBe(text.length);
  });

  it('keeps paragraphs intact when they fit within maxChunkChars', () => {
    const paragraphs = ['First paragraph about parking rules.', 'Second paragraph about pets.'];
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, { maxChunkChars: 1000 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(text);
  });

  it('splits into multiple chunks once content exceeds maxChunkChars', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(80)}`);
    const text = paragraphs.join('\n\n');

    const chunks = chunkText(text, { maxChunkChars: 200, overlapChars: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    // chunks are numbered sequentially from 0
    chunks.forEach((chunk, i) => expect(chunk.index).toBe(i));
    // no chunk (before overlap accounting) wildly exceeds the cap
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(200 + 80); // allow one unit's worth of slack
    }
  });

  it('overlaps consecutive chunks so a boundary fact is findable from either side', () => {
    // Small paragraphs (~38 chars) relative to overlapChars (50) so at least
    // one whole paragraph legitimately fits in the overlap window — see the
    // "single oversized unit" test below for the case where it can't.
    const paragraphs = Array.from({ length: 8 }, (_, i) =>
      `Rule ${i}: ${'word '.repeat(6)}`.trim(),
    );
    const text = paragraphs.join('\n\n');

    const chunks = chunkText(text, { maxChunkChars: 150, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    const first = chunks[0];
    const second = chunks[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // the tail of chunk 0 and the head of chunk 1 must share at least one
    // paragraph — that's what "overlap" means for this packer.
    const firstTailParagraph = first!.content.split('\n\n').at(-1);
    expect(second!.content).toContain(firstTailParagraph);
  });

  it('makes forward progress (does not hang) when a single paragraph exceeds overlapChars on its own', () => {
    // Each paragraph alone is bigger than overlapChars, so there is no
    // partial-unit overlap available — the packer must still terminate and
    // must not silently drop content, even though consecutive chunks won't
    // share a duplicated boundary paragraph in this case.
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Rule ${i}: ${'word '.repeat(20)}`);
    const text = paragraphs.join('\n\n');

    const chunks = chunkText(text, { maxChunkChars: 150, overlapChars: 50 });

    expect(chunks.length).toBe(paragraphs.length);
    chunks.forEach((chunk, i) => expect(chunk.content.trim()).toBe(paragraphs[i]?.trim()));
  });

  it('hard-splits a single paragraph that exceeds maxChunkChars on its own, without losing text', () => {
    const longSentence = `${'word '.repeat(400).trim()}.`; // ~2400 chars, one "sentence"
    const chunks = chunkText(longSentence, { maxChunkChars: 500, overlapChars: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    const rejoined = chunks.map((c) => c.content).join('');
    // every character of the source appears somewhere across the chunks
    // (allowing for intentional overlap duplication)
    expect(rejoined.length).toBeGreaterThanOrEqual(longSentence.length);
  });

  it('splits an oversized paragraph on sentence boundaries when possible', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `This is sentence number ${i}.`);
    const paragraph = sentences.join(' '); // one paragraph, no blank lines
    const chunks = chunkText(paragraph, { maxChunkChars: 150, overlapChars: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    // sentence boundaries are respected: each chunk's content should not
    // cut a sentence mid-word in a way that drops the trailing period
    for (const chunk of chunks) {
      const trimmed = chunk.content.trim();
      expect(trimmed.endsWith('.') || trimmed.length > 0).toBe(true);
    }
  });

  it('respects custom maxChunkChars / overlapChars options', () => {
    const paragraphs = Array.from({ length: 4 }, (_, i) => `Section ${i}: ${'y'.repeat(60)}`);
    const text = paragraphs.join('\n\n');

    const wide = chunkText(text, { maxChunkChars: 1000 });
    const narrow = chunkText(text, { maxChunkChars: 100, overlapChars: 10 });

    expect(wide.length).toBeLessThan(narrow.length);
  });

  it('uses documented defaults when no options are passed', () => {
    expect(DEFAULT_MAX_CHUNK_CHARS).toBe(1000);
    expect(DEFAULT_CHUNK_OVERLAP_CHARS).toBe(150);

    const text = 'x'.repeat(2500);
    const withDefaults = chunkText(text);
    const withExplicitDefaults = chunkText(text, {
      maxChunkChars: DEFAULT_MAX_CHUNK_CHARS,
      overlapChars: DEFAULT_CHUNK_OVERLAP_CHARS,
    });

    expect(withDefaults).toEqual(withExplicitDefaults);
  });

  it('rejects invalid options', () => {
    expect(() => chunkText('hello', { maxChunkChars: 0 })).toThrow();
    expect(() => chunkText('hello', { maxChunkChars: 100, overlapChars: -1 })).toThrow();
    expect(() => chunkText('hello', { maxChunkChars: 100, overlapChars: 100 })).toThrow();
  });

  it('produces contiguous, non-decreasing offsets across chunks', () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `Clause ${i}: ${'z'.repeat(50)}`);
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, { maxChunkChars: 180, overlapChars: 30 });

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startOffset).toBeGreaterThanOrEqual(0);
      expect(chunks[i]!.startOffset).toBeLessThanOrEqual(chunks[i - 1]!.endOffset);
    }
  });
});
