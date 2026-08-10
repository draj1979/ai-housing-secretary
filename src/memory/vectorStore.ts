/**
 * memory/vectorStore.ts
 *
 * Vector store adapter for the Knowledge Base (HLD Sec 5, 7.4). Backs
 * scripts/ingest-knowledge.ts (writes) and tools/knowledgeSearchTool.ts
 * (reads, once implemented). Provider is selected via config/env.ts
 * VECTOR_DB_PROVIDER — "pgvector" (default, since we're already running
 * Postgres for everything else) or "chroma".
 *
 * All three implementations here (`PgVectorStore`, `ChromaVectorStore`,
 * `InMemoryVectorStore`) satisfy the same `VectorStore` interface and report
 * scores on the same "cosine similarity, higher is more relevant" scale
 * (see memory/similarity.ts), so callers never need a provider-specific
 * branch.
 */
import { and, eq, sql } from 'drizzle-orm';
import { ChromaClient, type Collection, IncludeEnum, type IEmbeddingFunction } from 'chromadb';
import { loadEnv, type Env } from '../config/env.js';
import { getPostgresClient, type Database } from './postgresAdapter.js';
import { knowledgeChunks } from '../db/schema.js';
import { rankTopK } from './similarity.js';

export interface KnowledgeChunkInput {
  documentId: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  category?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSearchMatch {
  documentId: string;
  chunkIndex: number;
  content: string;
  /** Cosine similarity, roughly -1..1; higher is more relevant. */
  score: number;
  category?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface VectorStoreQueryOptions {
  category?: string;
}

export interface VectorStore {
  readonly provider: 'pgvector' | 'chroma' | 'memory';
  upsertChunks(chunks: KnowledgeChunkInput[]): Promise<void>;
  deleteDocumentChunks(documentId: string): Promise<void>;
  query(
    embedding: number[],
    topK: number,
    options?: VectorStoreQueryOptions,
  ): Promise<KnowledgeSearchMatch[]>;
}

function chunkKey(documentId: string, chunkIndex: number): string {
  return `${documentId}:${chunkIndex}`;
}

// ---------------------------------------------------------------------------
// PGVector — default provider (HLD Sec 5: "Embedding Store | ChromaDB / PGVector")
// ---------------------------------------------------------------------------

export class PgVectorStore implements VectorStore {
  readonly provider = 'pgvector' as const;

  constructor(private readonly db: Database = getPostgresClient()) {}

  async upsertChunks(chunks: KnowledgeChunkInput[]): Promise<void> {
    if (chunks.length === 0) return;

    // One upsert per row rather than a single multi-row insert: the
    // `embedding` custom column serializes to a driver-specific string per
    // value, which drizzle-orm's batch VALUES builder doesn't handle
    // uniformly across rows as cleanly as per-row inserts. Ingestion volume
    // here is a few hundred chunks at most, so this is not a hot path.
    for (const chunk of chunks) {
      await this.db
        .insert(knowledgeChunks)
        .values({
          documentId: chunk.documentId,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          category: chunk.category ?? null,
          embedding: chunk.embedding,
          metadata: chunk.metadata ?? {},
        })
        .onConflictDoUpdate({
          target: [knowledgeChunks.documentId, knowledgeChunks.chunkIndex],
          set: {
            content: chunk.content,
            category: chunk.category ?? null,
            embedding: chunk.embedding,
            metadata: chunk.metadata ?? {},
          },
        });
    }
  }

  async deleteDocumentChunks(documentId: string): Promise<void> {
    await this.db.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
  }

  async query(
    embedding: number[],
    topK: number,
    options?: VectorStoreQueryOptions,
  ): Promise<KnowledgeSearchMatch[]> {
    if (topK <= 0) return [];

    const vectorLiteral = `[${embedding.join(',')}]`;
    const categoryFilter = options?.category
      ? and(eq(knowledgeChunks.category, options.category))
      : undefined;

    const rows = await this.db
      .select({
        documentId: knowledgeChunks.documentId,
        chunkIndex: knowledgeChunks.chunkIndex,
        content: knowledgeChunks.content,
        category: knowledgeChunks.category,
        metadata: knowledgeChunks.metadata,
        // pgvector's `<=>` is cosine *distance*; similarity = 1 - distance,
        // matching the scale memory/similarity.ts's cosineSimilarity uses.
        score: sql<number>`1 - (${knowledgeChunks.embedding} <=> ${vectorLiteral}::vector)`,
      })
      .from(knowledgeChunks)
      .where(categoryFilter)
      .orderBy(sql`${knowledgeChunks.embedding} <=> ${vectorLiteral}::vector`)
      .limit(topK);

    return rows.map((row) => ({
      documentId: row.documentId,
      chunkIndex: row.chunkIndex,
      content: row.content,
      score: Number(row.score),
      ...(row.category !== null ? { category: row.category } : {}),
      metadata: row.metadata as Record<string, unknown>,
    }));
  }
}

// ---------------------------------------------------------------------------
// Chroma — alternative provider
// ---------------------------------------------------------------------------

/**
 * We always supply pre-computed Gemini embeddings (memory/embeddings.ts), so
 * Chroma's own embedding functions must never be invoked. This stub makes
 * that an explicit, loud failure instead of silently downloading a local
 * onnx model if a call site is ever changed to omit embeddings.
 */
const explicitEmbeddingsOnly: IEmbeddingFunction = {
  generate() {
    throw new Error(
      'ChromaVectorStore requires pre-computed embeddings from memory/embeddings.ts; ' +
        "Chroma's built-in embedding functions are intentionally disabled.",
    );
  },
};

export class ChromaVectorStore implements VectorStore {
  readonly provider = 'chroma' as const;

  private collectionPromise: Promise<Collection> | undefined;

  constructor(
    private readonly url: string,
    private readonly collectionName: string,
  ) {}

  private getCollection(): Promise<Collection> {
    if (!this.collectionPromise) {
      const client = new ChromaClient({ path: this.url });
      this.collectionPromise = client.getOrCreateCollection({
        name: this.collectionName,
        embeddingFunction: explicitEmbeddingsOnly,
        // Cosine space so scores land on the same scale as PgVectorStore's
        // `1 - cosine distance` and memory/similarity.ts's cosineSimilarity.
        metadata: { 'hnsw:space': 'cosine' },
      });
    }
    return this.collectionPromise;
  }

  async upsertChunks(chunks: KnowledgeChunkInput[]): Promise<void> {
    if (chunks.length === 0) return;
    const collection = await this.getCollection();

    await collection.upsert({
      ids: chunks.map((c) => chunkKey(c.documentId, c.chunkIndex)),
      embeddings: chunks.map((c) => c.embedding),
      documents: chunks.map((c) => c.content),
      metadatas: chunks.map((c) => ({
        documentId: c.documentId,
        chunkIndex: c.chunkIndex,
        category: c.category ?? '',
        metadataJson: JSON.stringify(c.metadata ?? {}),
      })),
    });
  }

  async deleteDocumentChunks(documentId: string): Promise<void> {
    const collection = await this.getCollection();
    await collection.delete({ where: { documentId } });
  }

  async query(
    embedding: number[],
    topK: number,
    options?: VectorStoreQueryOptions,
  ): Promise<KnowledgeSearchMatch[]> {
    if (topK <= 0) return [];
    const collection = await this.getCollection();

    const result = await collection.query({
      queryEmbeddings: [embedding],
      nResults: topK,
      ...(options?.category ? { where: { category: options.category } } : {}),
      include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
    });

    const ids = result.ids[0] ?? [];
    const documents = result.documents[0] ?? [];
    const metadatas = result.metadatas[0] ?? [];
    const distances = result.distances?.[0] ?? [];

    return ids.map((_id, i) => {
      const rawMetadata = (metadatas[i] ?? {}) as Record<string, unknown>;
      const metadataJson =
        typeof rawMetadata.metadataJson === 'string' ? rawMetadata.metadataJson : '{}';
      const category = typeof rawMetadata.category === 'string' ? rawMetadata.category : undefined;

      return {
        documentId: String(rawMetadata.documentId ?? ''),
        chunkIndex: Number(rawMetadata.chunkIndex ?? 0),
        content: documents[i] ?? '',
        // Cosine *distance* -> similarity, same scale as PgVectorStore.
        score: 1 - (distances[i] ?? 0),
        ...(category ? { category } : {}),
        metadata: JSON.parse(metadataJson) as Record<string, unknown>,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// In-memory — test double (used by vectorStore.test.ts)
// ---------------------------------------------------------------------------

/**
 * Fully in-process implementation of `VectorStore` used by unit tests
 * (top-k similarity search behavior without a live Postgres/Chroma). Not
 * wired into createVectorStore() — it's not a supported production
 * provider, since it has no persistence and doesn't scale past a handful of
 * documents.
 */
export class InMemoryVectorStore implements VectorStore {
  readonly provider = 'memory' as const;

  private readonly chunks = new Map<string, KnowledgeChunkInput>();

  async upsertChunks(chunks: KnowledgeChunkInput[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunkKey(chunk.documentId, chunk.chunkIndex), chunk);
    }
  }

  async deleteDocumentChunks(documentId: string): Promise<void> {
    const prefix = `${documentId}:`;
    for (const key of this.chunks.keys()) {
      if (key.startsWith(prefix)) this.chunks.delete(key);
    }
  }

  async query(
    embedding: number[],
    topK: number,
    options?: VectorStoreQueryOptions,
  ): Promise<KnowledgeSearchMatch[]> {
    const candidates = [...this.chunks.values()].filter(
      (c) => !options?.category || c.category === options.category,
    );

    return rankTopK(
      candidates.map((c) => ({ item: c, embedding: c.embedding })),
      embedding,
      topK,
    ).map(({ item, score }) => ({
      documentId: item.documentId,
      chunkIndex: item.chunkIndex,
      content: item.content,
      score,
      category: item.category,
      metadata: item.metadata,
    }));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVectorStore(env: Env = loadEnv()): VectorStore {
  if (env.VECTOR_DB_PROVIDER === 'chroma') {
    if (!env.CHROMA_URL) {
      throw new Error('CHROMA_URL is required when VECTOR_DB_PROVIDER=chroma.');
    }
    return new ChromaVectorStore(env.CHROMA_URL, env.CHROMA_COLLECTION);
  }
  return new PgVectorStore(getPostgresClient());
}
