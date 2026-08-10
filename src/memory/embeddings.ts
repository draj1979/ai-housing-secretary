/**
 * memory/embeddings.ts
 *
 * Wraps the Gemini embedding model (config/env.ts EMBEDDING_MODEL, default
 * `text-embedding-004`) used to turn knowledge-base chunks and resident
 * queries into vectors for memory/vectorStore.ts (HLD Sec 5, 7.4).
 *
 * Two task types are used deliberately (per Gemini's embedding API): content
 * being *stored* is embedded as RETRIEVAL_DOCUMENT, content being *searched
 * for* is embedded as RETRIEVAL_QUERY. Gemini optimizes the vector space
 * differently for each, and mixing them up quietly degrades retrieval
 * quality — don't collapse the two into one function.
 */
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import { loadEnv } from '../config/env.js';

/**
 * Output dimensionality of `text-embedding-004`. Canonical source of truth —
 * duplicated (not imported) into db/schema.ts as EMBEDDING_DIMENSIONS
 * because drizzle-kit's CJS schema loader can't resolve cross-file ESM
 * imports out of this package; kept in sync by src/db/schema.test.ts. If you
 * change EMBEDDING_MODEL to a model with a different output size, update
 * both places and regenerate the migration.
 */
export const EMBEDDING_DIMENSIONS = 768;

export type EmbeddingPurpose = 'document' | 'query';

function toTaskType(purpose: EmbeddingPurpose): TaskType {
  return purpose === 'query' ? TaskType.RETRIEVAL_QUERY : TaskType.RETRIEVAL_DOCUMENT;
}

let client: GoogleGenerativeAI | undefined;

function getClient(): GoogleGenerativeAI {
  if (!client) {
    const env = loadEnv();
    if (!env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is required to compute embeddings.');
    }
    client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }
  return client;
}

/** Embeds a single piece of text. Prefer `embedBatch` for more than a few strings. */
export async function embedText(text: string, purpose: EmbeddingPurpose): Promise<number[]> {
  const env = loadEnv();
  const model = getClient().getGenerativeModel({ model: env.EMBEDDING_MODEL });
  const { embedding } = await model.embedContent({
    content: { role: 'user', parts: [{ text }] },
    taskType: toTaskType(purpose),
  });
  return embedding.values;
}

/**
 * Embeds many strings in one request via Gemini's batch endpoint — used by
 * scripts/ingest-knowledge.ts so ingesting a whole document doesn't cost one
 * round trip per chunk.
 */
export async function embedBatch(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]> {
  if (texts.length === 0) return [];
  const env = loadEnv();
  const model = getClient().getGenerativeModel({ model: env.EMBEDDING_MODEL });
  const taskType = toTaskType(purpose);
  const { embeddings } = await model.batchEmbedContents({
    requests: texts.map((text) => ({
      content: { role: 'user', parts: [{ text }] },
      taskType,
    })),
  });
  return embeddings.map((e) => e.values);
}
