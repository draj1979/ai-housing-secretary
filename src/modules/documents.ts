/**
 * modules/documents.ts
 *
 * Society document management (HLD Sec 7.4, 14 — the `GCP_STORAGE_BUCKET`
 * provisioned by scripts/provision-gcp.sh for exactly this, previously
 * unwired to any actual code path). Two callers share this module:
 *
 *   - scripts/ingest-knowledge.ts — the original CLI path, reads local
 *     `.md` files from /docs/knowledge.
 *   - gateway/adminDocumentsRoutes.ts — the admin dashboard's upload
 *     endpoint, reads an uploaded file's bytes over HTTP.
 *
 * Both funnel into `ingestDocument` below so there is exactly one place
 * that knows how a document becomes searchable (chunk -> embed -> upsert
 * into the vector store -> upsert its `knowledge_documents` provenance
 * row) — the same "single source of truth" reasoning as every other
 * module in this repo (see e.g. gateway/adminRoutes.ts reusing
 * modules/escalation.ts rather than a bespoke query).
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { knowledgeDocuments } from '../db/schema.js';
import { chunkText } from '../memory/chunking.js';
import { embedBatch } from '../memory/embeddings.js';
import type { VectorStore } from '../memory/vectorStore.js';
import type { Database } from '../memory/postgresAdapter.js';

/**
 * The six document categories HLD Sec 7.4 names. `id` is what's actually
 * stored in `knowledge_documents.category` (a free-text `varchar`, not a
 * Postgres enum — see db/schema.ts — so adding a category here needs no
 * migration). `modules/faq.ts`'s `FAQ_KNOWLEDGE_CATEGORIES` deliberately
 * scopes FAQ *search* to only 4 of these (see that file's own comment on
 * why handbook/emergency_contacts are excluded from FAQ answers) — that's
 * a narrower, separate concern from "which categories can a document be
 * filed under," which is all this list is for.
 */
export const KNOWLEDGE_CATEGORIES = [
  { id: 'handbook', label: 'Society Handbook' },
  { id: 'bye_laws', label: 'Bye-Laws' },
  { id: 'parking_policy', label: 'Parking Policy' },
  { id: 'emergency_contacts', label: 'Emergency Contacts' },
  { id: 'maintenance_rules', label: 'Maintenance Rules' },
  { id: 'clubhouse_rules', label: 'Clubhouse Rules' },
] as const;

export type KnowledgeCategoryId = (typeof KNOWLEDGE_CATEGORIES)[number]['id'];

export function isKnowledgeCategoryId(value: unknown): value is KnowledgeCategoryId {
  return typeof value === 'string' && KNOWLEDGE_CATEGORIES.some((c) => (c.id as string) === value);
}

export interface IngestDocumentInput {
  /** Human-readable name shown in the dashboard/FAQ citations. */
  title: string;
  category: string;
  /**
   * Stable identity for "is this the same document as before" (upsert-by
   * this-key). The CLI path uses a `docs/knowledge/<file>.md` relative
   * path; the upload path uses the GCS object path
   * (`gs://bucket/documents/<uuid>-<filename>`) `documentStorage.ts`
   * returns — either way, unique and stable across re-ingestion.
   */
  sourceUri: string;
  /** Already-extracted plain text — see extractText() for how upload gets here from raw bytes. */
  content: string;
}

export interface IngestDocumentResult {
  documentId: string;
  title: string;
  category: string;
  version: number;
  chunkCount: number;
  /** false when re-ingesting unchanged content — chunking/embedding was skipped, existing chunks untouched. */
  changed: boolean;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Chunks, embeds, and upserts one document — insert-or-update by
 * `sourceUri`, bumping `version` and replacing vector-store chunks only
 * when content actually changed (byte-for-byte via sha256), same
 * idempotency scripts/ingest-knowledge.ts has always had.
 */
export async function ingestDocument(
  db: Database,
  vectorStore: VectorStore,
  input: IngestDocumentInput,
): Promise<IngestDocumentResult> {
  const hash = contentHash(input.content);

  const [existing] = await db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.sourceUri, input.sourceUri))
    .limit(1);

  const changed = !existing || existing.contentHash !== hash;
  const version = existing ? existing.version + (changed ? 1 : 0) : 1;

  const [document] = existing
    ? await db
        .update(knowledgeDocuments)
        .set({ title: input.title, category: input.category, version, contentHash: hash })
        .where(eq(knowledgeDocuments.id, existing.id))
        .returning()
    : await db
        .insert(knowledgeDocuments)
        .values({
          title: input.title,
          category: input.category,
          sourceUri: input.sourceUri,
          version,
          contentHash: hash,
        })
        .returning();

  if (!document)
    throw new Error(`Failed to upsert knowledge_documents row for ${input.sourceUri}.`);

  if (!changed) {
    return {
      documentId: document.id,
      title: input.title,
      category: input.category,
      version,
      chunkCount: 0,
      changed: false,
    };
  }

  const chunks = chunkText(input.content);
  const embeddings = await embedBatch(
    chunks.map((c) => c.content),
    'document',
  );

  await vectorStore.deleteDocumentChunks(document.id);
  await vectorStore.upsertChunks(
    chunks.map((chunk, i) => ({
      documentId: document.id,
      chunkIndex: chunk.index,
      content: chunk.content,
      embedding: embeddings[i] ?? [],
      category: input.category,
      metadata: {
        title: input.title,
        sourceUri: input.sourceUri,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
      },
    })),
  );

  return {
    documentId: document.id,
    title: input.title,
    category: input.category,
    version,
    chunkCount: chunks.length,
    changed: true,
  };
}

export interface DocumentSummary {
  id: string;
  title: string;
  category: string;
  sourceUri: string;
  version: number;
  uploadedAt: Date;
}

/** Every document's provenance row — gateway/adminDocumentsRoutes.ts's dashboard list. */
export async function listDocuments(db: Database): Promise<DocumentSummary[]> {
  const rows = await db
    .select({
      id: knowledgeDocuments.id,
      title: knowledgeDocuments.title,
      category: knowledgeDocuments.category,
      sourceUri: knowledgeDocuments.sourceUri,
      version: knowledgeDocuments.version,
      uploadedAt: knowledgeDocuments.uploadedAt,
    })
    .from(knowledgeDocuments)
    .orderBy(knowledgeDocuments.uploadedAt);
  return rows;
}

/**
 * Removes a document's provenance row and every one of its vector-store
 * chunks — does NOT delete the underlying GCS object (the dashboard route
 * that calls this also calls documentStorage.delete() for that; kept
 * separate so this module has no GCS dependency of its own, matching
 * memory/vectorStore.ts's own provider-agnostic design).
 */
export async function deleteDocument(
  db: Database,
  vectorStore: VectorStore,
  documentId: string,
): Promise<{ sourceUri: string } | null> {
  const [existing] = await db
    .select({ sourceUri: knowledgeDocuments.sourceUri })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.id, documentId))
    .limit(1);
  if (!existing) return null;

  await vectorStore.deleteDocumentChunks(documentId);
  await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, documentId));
  return existing;
}

export interface DocumentsModule {
  ingest(input: IngestDocumentInput): Promise<IngestDocumentResult>;
  list(): Promise<DocumentSummary[]>;
  remove(documentId: string): Promise<{ sourceUri: string } | null>;
}

/**
 * Binds `db`/`vectorStore` once, for callers that just want
 * "ingest/list/remove" without wiring those two through themselves —
 * gateway/adminDocumentsRoutes.ts's dependency, so its route handlers
 * (and their tests) work against a plain three-method interface, the
 * same injectable-module shape gateway/adminRoutes.ts's
 * `escalationModule` already established.
 */
export function createDocumentsModule(db: Database, vectorStore: VectorStore): DocumentsModule {
  return {
    ingest: (input) => ingestDocument(db, vectorStore, input),
    list: () => listDocuments(db),
    remove: (documentId) => deleteDocument(db, vectorStore, documentId),
  };
}
