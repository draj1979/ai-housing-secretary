/**
 * modules/documentTextExtraction.ts
 *
 * Turns an uploaded file's raw bytes into plain text for
 * modules/documents.ts's ingestDocument() — the one step
 * scripts/ingest-knowledge.ts never needed (it only ever read `.md`
 * files directly as UTF-8). Deliberately small and format-list-driven
 * rather than trying to guess: an unsupported mimetype is a clear 415,
 * not a best-effort mangled extraction.
 */
import { PDFParse } from 'pdf-parse';

export const SUPPORTED_UPLOAD_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/pdf',
] as const;

export function isSupportedUploadMimeType(mimetype: string): boolean {
  return (SUPPORTED_UPLOAD_MIME_TYPES as readonly string[]).includes(mimetype);
}

/**
 * @throws if `mimetype` isn't one of SUPPORTED_UPLOAD_MIME_TYPES, or the
 * PDF can't be parsed (encrypted/corrupt/scanned-image-only with no text
 * layer — this does not OCR).
 */
export async function extractText(buffer: Buffer, mimetype: string): Promise<string> {
  if (mimetype === 'text/plain' || mimetype === 'text/markdown') {
    return buffer.toString('utf-8');
  }
  if (mimetype === 'application/pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  throw new Error(
    `Unsupported file type "${mimetype}" — supported: ${SUPPORTED_UPLOAD_MIME_TYPES.join(', ')}.`,
  );
}
