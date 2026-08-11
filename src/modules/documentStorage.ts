/**
 * modules/documentStorage.ts
 *
 * Raw file bytes for uploaded society documents (HLD Sec 14's
 * `GCP_STORAGE_BUCKET` — "society documents", provisioned by
 * scripts/provision-gcp.sh since that script's very first version but
 * never actually written to by any code path until the admin dashboard).
 * Deliberately separate from modules/documents.ts (which only ever
 * touches extracted *text* + the vector store) — this is the one place
 * that knows about `@google-cloud/storage`, mirroring
 * security/fieldEncryption.ts / tools/whatsappTool.ts's own
 * one-module-owns-one-external-concern pattern.
 *
 * Auth: relies on Application Default Credentials — the same "no key
 * file" story as everything else in this repo's GCP surface (the VM's
 * own attached service account in production, `gcloud auth
 * application-default login` for local dev — see docs/deployment.md's
 * "CI/CD Auth"/"Secret flow" sections for the analogous pattern
 * elsewhere). No new credential type introduced.
 */
import { randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';

export interface DocumentStorageConfig {
  bucket: string;
}

export interface UploadedFile {
  /** GCS object path within the bucket, e.g. "documents/<uuid>-bye-laws.pdf". */
  objectPath: string;
  /** Full gs:// URI — this is what's stored as knowledge_documents.source_uri. */
  gcsUri: string;
}

export interface DocumentStorage {
  /** Uploads raw bytes under documents/<uuid>-<safe-filename>; returns both the object path and its gs:// URI. */
  upload(filename: string, buffer: Buffer, contentType: string): Promise<UploadedFile>;
  /** Deletes the object at objectPath — never throws if it's already gone (a document row can outlive its blob without this becoming a hard failure). */
  delete(objectPath: string): Promise<void>;
}

/** Strips anything that isn't safe in a GCS object path/URL, keeping the upload traceable to its original filename. */
function safeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-150);
}

export function createDocumentStorage(config: DocumentStorageConfig): DocumentStorage {
  const storage = new Storage();
  const bucket = storage.bucket(config.bucket);

  return {
    async upload(filename, buffer, contentType) {
      const objectPath = `documents/${randomUUID()}-${safeFilename(filename)}`;
      const file = bucket.file(objectPath);
      await file.save(buffer, { contentType, resumable: false });
      return { objectPath, gcsUri: `gs://${config.bucket}/${objectPath}` };
    },

    async delete(objectPath) {
      await bucket
        .file(objectPath)
        .delete({ ignoreNotFound: true })
        .catch(() => undefined);
    },
  };
}

/** GCS object path from a "gs://bucket/path" URI — the inverse of upload()'s gcsUri, used when deleting by stored source_uri. */
export function objectPathFromGcsUri(gcsUri: string): string | null {
  const match = /^gs:\/\/[^/]+\/(.+)$/.exec(gcsUri);
  return match?.[1] ?? null;
}
