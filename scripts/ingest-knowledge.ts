/**
 * scripts/ingest-knowledge.ts
 *
 * Chunks and embeds the society's knowledge-base documents (HLD Sec 7.4:
 * Society Handbook, Bye-Laws, Parking Policy, Emergency Contacts,
 * Maintenance Rules, Clubhouse Rules) from /docs/knowledge into the
 * configured vector store (memory/vectorStore.ts), and records/updates each
 * document's provenance row in the `knowledge_documents` table.
 *
 * Idempotent: re-running re-reads each file, bumps that document's version
 * if its content changed, and replaces its chunks in the vector store —
 * safe to run repeatedly (e.g. after editing a policy doc) or on a schedule.
 *
 * Usage:
 *   pnpm knowledge:ingest
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { closePostgresClient, getPostgresClient } from '../src/memory/postgresAdapter.js';
import { knowledgeDocuments } from '../src/db/schema.js';
import { chunkText } from '../src/memory/chunking.js';
import { embedBatch } from '../src/memory/embeddings.js';
import { createVectorStore } from '../src/memory/vectorStore.js';

const KNOWLEDGE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'knowledge',
);

/**
 * Filename -> category (matches the enum documented in db/schema.ts's
 * knowledge_documents comment and the HLD Sec 7.4 document list).
 */
const KNOWLEDGE_CATEGORIES: Record<string, string> = {
  'society-handbook.md': 'handbook',
  'bye-laws.md': 'bye_laws',
  'parking-policy.md': 'parking_policy',
  'emergency-contacts.md': 'emergency_contacts',
  'maintenance-rules.md': 'maintenance_rules',
  'clubhouse-rules.md': 'clubhouse_rules',
};

interface IngestSummary {
  file: string;
  title: string;
  category: string;
  chunkCount: number;
  version: number;
  changed: boolean;
}

/** First markdown H1, falling back to a title-cased filename. */
function deriveTitle(filename: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  return path
    .basename(filename, '.md')
    .split('-')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ');
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function ingestFile(
  db: ReturnType<typeof getPostgresClient>,
  vectorStore: ReturnType<typeof createVectorStore>,
  filename: string,
): Promise<IngestSummary> {
  const category = KNOWLEDGE_CATEGORIES[filename];
  if (!category) {
    throw new Error(
      `${filename} has no entry in KNOWLEDGE_CATEGORIES — add one before ingesting it.`,
    );
  }

  const fullPath = path.join(KNOWLEDGE_DIR, filename);
  const content = await readFile(fullPath, 'utf-8');
  const title = deriveTitle(filename, content);
  const sourceUri = path.posix.join('docs', 'knowledge', filename);
  const hash = contentHash(content);

  const [existing] = await db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.sourceUri, sourceUri))
    .limit(1);

  const changed = !existing || existing.contentHash !== hash;
  const version = existing ? existing.version + (changed ? 1 : 0) : 1;

  const [document] = existing
    ? await db
        .update(knowledgeDocuments)
        .set({ title, category, version, contentHash: hash })
        .where(eq(knowledgeDocuments.id, existing.id))
        .returning()
    : await db
        .insert(knowledgeDocuments)
        .values({ title, category, sourceUri, version, contentHash: hash })
        .returning();

  if (!document) throw new Error(`Failed to upsert knowledge_documents row for ${filename}.`);

  // Re-chunk and re-embed even when unchanged is wasteful but harmless; skip
  // the (comparatively expensive) embedding call when content is unchanged.
  if (changed) {
    const chunks = chunkText(content);
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
        category,
        metadata: { title, sourceUri, startOffset: chunk.startOffset, endOffset: chunk.endOffset },
      })),
    );

    return { file: filename, title, category, chunkCount: chunks.length, version, changed };
  }

  return { file: filename, title, category, chunkCount: 0, version, changed };
}

async function main(): Promise<void> {
  const db = getPostgresClient();
  const vectorStore = createVectorStore();

  const files = (await readdir(KNOWLEDGE_DIR))
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    console.warn(`No .md files found in ${KNOWLEDGE_DIR}.`);
    return;
  }

  console.log(
    `Ingesting ${files.length} document(s) from ${KNOWLEDGE_DIR} via ${vectorStore.provider}...`,
  );

  const summaries: IngestSummary[] = [];
  for (const file of files) {
    const summary = await ingestFile(db, vectorStore, file);
    summaries.push(summary);
    console.log(
      summary.changed
        ? `  [${summary.category}] ${summary.file} -> v${summary.version}, ${summary.chunkCount} chunks`
        : `  [${summary.category}] ${summary.file} -> unchanged, skipped re-embedding`,
    );
  }

  console.log(`Ingestion complete: ${summaries.length} document(s) processed.`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .catch((err: unknown) => {
      console.error('Knowledge ingestion failed:', err);
      process.exitCode = 1;
    })
    .finally(() => closePostgresClient());
}
