/**
 * gateway/adminDocumentsRoutes.ts
 *
 * The admin dashboard's document-management API (HLD Sec 7.4, 14) —
 * upload a society document (bye-laws, parking policy, maintenance
 * rules, ...), see what's currently ingested, remove one. Listing
 * (`GET /admin/documents`) allows both `secretary` and `read_only`, same
 * split as gateway/adminRoutes.ts's escalations queue; upload and delete
 * are `secretary`-only — there's no HLD-specified "committee can upload
 * or remove documents" role, so mutation stays secretary-only rather than
 * inventing one.
 *
 * Depends on `documentsModule` (modules/documents.ts's
 * `createDocumentsModule`) rather than raw `db`/`vectorStore` — the same
 * injectable-module shape gateway/adminRoutes.ts's `escalationModule`
 * already established, so this file's tests (adminDocumentsRoutes.test.ts)
 * inject a fake module instead of standing up a real Postgres/pgvector.
 * It's the *same* module scripts/ingest-knowledge.ts's CLI path ultimately
 * calls into (via ingestDocument directly there), so uploading through
 * the dashboard and running `pnpm knowledge:ingest` can never disagree
 * about what "ingested" means.
 */
import type { FastifyInstance } from 'fastify';
import { requireAdminAuth, requireRole, type AdminAuthConfig } from './adminAuth.js';
import {
  isKnowledgeCategoryId,
  KNOWLEDGE_CATEGORIES,
  type DocumentsModule,
} from '../modules/documents.js';
import {
  extractText,
  isSupportedUploadMimeType,
  SUPPORTED_UPLOAD_MIME_TYPES,
} from '../modules/documentTextExtraction.js';
import { objectPathFromGcsUri, type DocumentStorage } from '../modules/documentStorage.js';

export interface AdminDocumentsRoutesDeps {
  authConfig: AdminAuthConfig;
  documentsModule: DocumentsModule;
  documentStorage: DocumentStorage;
  /** Hard cap on an uploaded file's size, bytes — default 20MB, generous for a policy PDF, small enough to bound one request's memory/embedding cost. */
  maxUploadBytes?: number;
}

const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * A multipart text field's value — @fastify/multipart types a file's
 * `.fields` entry as `Multipart | Multipart[] | undefined` (an array only
 * when the same field name repeats, which never happens for this route's
 * single title/category fields); narrowed locally rather than importing
 * the library's own union type, which this repo's `export =`-style
 * `@fastify/multipart` typings don't expose as a named import.
 */
function multipartFieldValue(field: unknown): string {
  const candidate = Array.isArray(field) ? field[0] : field;
  if (
    candidate &&
    typeof candidate === 'object' &&
    'value' in candidate &&
    typeof candidate.value === 'string'
  ) {
    return candidate.value;
  }
  return '';
}

export function registerAdminDocumentsRoutes(
  app: FastifyInstance,
  deps: AdminDocumentsRoutesDeps,
): void {
  const auth = requireAdminAuth(deps.authConfig);
  const secretaryOnly = requireRole('secretary');

  app.get(
    '/admin/documents',
    { preHandler: [auth, requireRole('secretary', 'read_only')] },
    async () => {
      const documents = await deps.documentsModule.list();
      return { documents, categories: KNOWLEDGE_CATEGORIES };
    },
  );

  app.post('/admin/documents', { preHandler: [auth, secretaryOnly] }, async (request, reply) => {
    const file = await request.file({
      limits: { fileSize: deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES },
    });
    if (!file) {
      return reply.code(400).send({ error: 'multipart file field is required.' });
    }

    const title = multipartFieldValue(file.fields.title).trim();
    const category = multipartFieldValue(file.fields.category);

    if (!title) {
      return reply.code(400).send({ error: 'form field "title" is required.' });
    }
    if (!isKnowledgeCategoryId(category)) {
      return reply.code(400).send({
        error: `form field "category" must be one of: ${KNOWLEDGE_CATEGORIES.map((c) => c.id).join(', ')}.`,
      });
    }
    if (!isSupportedUploadMimeType(file.mimetype)) {
      return reply.code(415).send({
        error: `Unsupported file type "${file.mimetype}" — supported: ${SUPPORTED_UPLOAD_MIME_TYPES.join(', ')}.`,
      });
    }

    const buffer = await file.toBuffer();

    let content: string;
    try {
      content = await extractText(buffer, file.mimetype);
    } catch (err) {
      return reply.code(422).send({
        error: `Could not extract text from this file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (!content.trim()) {
      return reply.code(422).send({ error: 'No extractable text found in this file.' });
    }

    const uploaded = await deps.documentStorage.upload(file.filename, buffer, file.mimetype);
    const result = await deps.documentsModule.ingest({
      title,
      category,
      sourceUri: uploaded.gcsUri,
      content,
    });

    return reply.code(201).send({ document: result, gcsUri: uploaded.gcsUri });
  });

  app.delete<{ Params: { id: string } }>(
    '/admin/documents/:id',
    { preHandler: [auth, secretaryOnly] },
    async (request, reply) => {
      const deleted = await deps.documentsModule.remove(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'No document with that id.' });
      }
      const objectPath = objectPathFromGcsUri(deleted.sourceUri);
      if (objectPath) {
        await deps.documentStorage.delete(objectPath);
      }
      return { deleted: true };
    },
  );
}
