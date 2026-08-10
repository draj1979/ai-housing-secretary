/**
 * tools/knowledgeSearchTool.ts
 *
 * Knowledge Base search tool (HLD Sec 6.2, 7.4). Embeds the resident's
 * query (memory/embeddings.ts, RETRIEVAL_QUERY) and runs top-k similarity
 * search against the configured vector store (memory/vectorStore.ts —
 * PGVector or Chroma, populated by scripts/ingest-knowledge.ts from
 * /docs/knowledge), returning results shaped for direct use as Gemini RAG
 * context (agent/gemini.ts).
 */
import { embedText } from '../memory/embeddings.js';
import { createVectorStore, type VectorStore } from '../memory/vectorStore.js';

export interface KnowledgeSearchResult {
  documentTitle: string;
  excerpt: string;
  /** Cosine similarity, roughly -1..1; higher is more relevant (memory/similarity.ts scale). */
  score: number;
  category?: string;
}

export interface KnowledgeSearchOptions {
  /** Number of chunks to retrieve. Default 3. */
  topK?: number;
  /** Restrict to one knowledge_documents category (e.g. "parking_policy"). */
  category?: string;
}

export interface KnowledgeSearchTool {
  search(query: string, options?: KnowledgeSearchOptions): Promise<KnowledgeSearchResult[]>;
}

const DEFAULT_TOP_K = 3;

/**
 * A chunk's metadata carries its parent document's title
 * (scripts/ingest-knowledge.ts writes `{ title, sourceUri, ... }` per
 * chunk) — falls back to a generic label if that's ever missing rather than
 * surfacing `undefined` to a resident-facing reply.
 */
function titleFromMetadata(metadata: Record<string, unknown> | undefined): string {
  return typeof metadata?.title === 'string' ? metadata.title : 'Society Knowledge Base';
}

export function createKnowledgeSearchTool(
  vectorStore: VectorStore = createVectorStore(),
): KnowledgeSearchTool {
  return {
    async search(query, options) {
      const embedding = await embedText(query, 'query');
      const matches = await vectorStore.query(
        embedding,
        options?.topK ?? DEFAULT_TOP_K,
        options?.category ? { category: options.category } : undefined,
      );

      return matches.map((match) => ({
        documentTitle: titleFromMetadata(match.metadata),
        excerpt: match.content,
        score: match.score,
        ...(match.category ? { category: match.category } : {}),
      }));
    },
  };
}
