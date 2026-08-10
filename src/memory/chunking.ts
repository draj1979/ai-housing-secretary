/**
 * memory/chunking.ts
 *
 * Pure text-chunking used by scripts/ingest-knowledge.ts to split society
 * documents (HLD Sec 7.4) into embedding-sized pieces before they go into
 * memory/vectorStore.ts. Deliberately has no I/O or async code so it can be
 * unit-tested without a database or network — see chunking.test.ts.
 *
 * Strategy: split on paragraph boundaries first (the natural unit for a
 * handbook/bye-laws document), fall back to sentence boundaries for any
 * paragraph that's still too big, and fall back to a hard character split
 * for any sentence that's still too big (pathological input, e.g. no
 * punctuation at all). Chunks are then greedily packed up to
 * `maxChunkChars`, with the tail of each chunk repeated at the start of the
 * next (`overlapChars`) so a fact split across a chunk boundary is still
 * findable from either side.
 */

export interface ChunkOptions {
  /** Soft cap on characters per chunk. Default 1000. */
  maxChunkChars?: number;
  /** Characters of trailing context repeated at the start of the next chunk. Default 150. */
  overlapChars?: number;
}

export interface TextChunk {
  /** 0-based position of this chunk within the document. */
  index: number;
  content: string;
  /** Character offset of this chunk's first unit in the normalized source text. */
  startOffset: number;
  /** Character offset (exclusive) of this chunk's last unit in the normalized source text. */
  endOffset: number;
}

export const DEFAULT_MAX_CHUNK_CHARS = 1000;
export const DEFAULT_CHUNK_OVERLAP_CHARS = 150;

interface Unit {
  text: string;
  start: number;
  end: number;
}

export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS;

  if (maxChunkChars <= 0) {
    throw new Error('maxChunkChars must be greater than 0.');
  }
  if (overlapChars < 0 || overlapChars >= maxChunkChars) {
    throw new Error('overlapChars must be >= 0 and less than maxChunkChars.');
  }

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const units = splitParagraphs(normalized).flatMap((unit) =>
    unit.text.length > maxChunkChars ? splitOversizedUnit(unit, maxChunkChars) : [unit],
  );

  return packUnits(units, maxChunkChars, overlapChars);
}

/** Splits normalized text into paragraphs (blocks separated by one or more blank lines). */
function splitParagraphs(text: string): Unit[] {
  const units: Unit[] = [];
  const blankLineRe = /\n{2,}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushParagraph = (raw: string, offset: number) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const leading = raw.length - raw.trimStart().length;
    const start = offset + leading;
    units.push({ text: trimmed, start, end: start + trimmed.length });
  };

  while ((match = blankLineRe.exec(text))) {
    pushParagraph(text.slice(lastIndex, match.index), lastIndex);
    lastIndex = match.index + match[0].length;
  }
  pushParagraph(text.slice(lastIndex), lastIndex);

  return units;
}

/** A paragraph too big for one chunk: split into sentences, then hard-split any that are still too big. */
function splitOversizedUnit(unit: Unit, maxChunkChars: number): Unit[] {
  return splitSentences(unit).flatMap((sentence) =>
    sentence.text.length > maxChunkChars ? hardSplit(sentence, maxChunkChars) : [sentence],
  );
}

function splitSentences(unit: Unit): Unit[] {
  const units: Unit[] = [];
  // A "sentence" is a run of non-terminator characters followed by
  // terminating punctuation (or end of string, for a trailing fragment).
  const sentenceRe = /[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g;
  let match: RegExpExecArray | null;

  while ((match = sentenceRe.exec(unit.text))) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const leading = raw.length - raw.trimStart().length;
    const start = unit.start + match.index + leading;
    units.push({ text: trimmed, start, end: start + trimmed.length });
  }

  return units.length > 0 ? units : [unit];
}

/** Last resort for a "sentence" with no punctuation at all: split on raw character count. */
function hardSplit(unit: Unit, maxChunkChars: number): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < unit.text.length; i += maxChunkChars) {
    const slice = unit.text.slice(i, i + maxChunkChars);
    const start = unit.start + i;
    out.push({ text: slice, start, end: start + slice.length });
  }
  return out;
}

/** Greedily packs units into chunks up to maxChunkChars, overlapping trailing units between chunks. */
function packUnits(units: Unit[], maxChunkChars: number, overlapChars: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  let i = 0;

  while (i < units.length) {
    let j = i;
    let length = 0;

    while (j < units.length) {
      const separator = j > i ? 2 : 0; // joined with "\n\n"
      const addition = (units[j] as Unit).text.length + separator;
      if (length + addition > maxChunkChars && j > i) break;
      length += addition;
      j++;
    }
    if (j === i) j = i + 1; // guarantee progress even for a pathological single unit

    const chunkUnits = units.slice(i, j);
    const first = chunkUnits[0] as Unit;
    const last = chunkUnits[chunkUnits.length - 1] as Unit;

    chunks.push({
      index: chunks.length,
      content: chunkUnits.map((u) => u.text).join('\n\n'),
      startOffset: first.start,
      endOffset: last.end,
    });

    if (j >= units.length) break;

    // Walk back from the end of this chunk far enough to cover overlapChars,
    // so the next chunk starts with recent context instead of a hard cut.
    let k = j;
    let overlapLen = 0;
    while (k > i && overlapLen < overlapChars) {
      k--;
      overlapLen += (units[k] as Unit).text.length;
    }
    // Guarantee forward progress: if this chunk was a single oversized unit
    // (k walked all the way back to i), taking k as-is would make the next
    // chunk start at the same position as this one, looping forever. In
    // that case we accept no overlap for this boundary rather than hang —
    // a paragraph bigger than overlapChars is the only way to hit this.
    i = Math.max(k, i + 1);
  }

  return chunks;
}
