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
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvAsync } from '../src/config/env.js';
import { closePostgresClient, getPostgresClient } from '../src/memory/postgresAdapter.js';
import { createVectorStore } from '../src/memory/vectorStore.js';
import { ingestDocument } from '../src/modules/documents.js';

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

/**
 * Reads one local file and hands it to modules/documents.ts's
 * ingestDocument() — the same chunk/embed/upsert logic
 * gateway/adminDocumentsRoutes.ts's upload endpoint uses, so this CLI
 * path and the dashboard can never disagree about what "ingested" means.
 * This function's own job is just "turn a filename into
 * ingestDocument's inputs": deriving a title, mapping the filename to a
 * category, and reading the file as UTF-8 text.
 */
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

  const result = await ingestDocument(db, vectorStore, { title, category, sourceUri, content });
  return { file: filename, ...result };
}

async function main(): Promise<void> {
  // Real process entry point (HLD Sec 15) — see src/db/migrate.ts's
  // identical comment/fix; getPostgresClient()/createVectorStore() below
  // both lazily re-validate process.env via bare loadEnv() otherwise.
  await loadEnvAsync();
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
