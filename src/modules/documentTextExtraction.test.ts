import { describe, expect, it } from 'vitest';
import {
  extractText,
  isSupportedUploadMimeType,
  SUPPORTED_UPLOAD_MIME_TYPES,
} from './documentTextExtraction.js';

describe('isSupportedUploadMimeType', () => {
  it('accepts every supported type', () => {
    for (const mimetype of SUPPORTED_UPLOAD_MIME_TYPES) {
      expect(isSupportedUploadMimeType(mimetype)).toBe(true);
    }
  });

  it('rejects an unsupported type', () => {
    expect(isSupportedUploadMimeType('application/zip')).toBe(false);
    expect(isSupportedUploadMimeType('image/png')).toBe(false);
  });
});

describe('extractText', () => {
  it('reads text/plain as UTF-8 as-is', async () => {
    const text = await extractText(
      Buffer.from('Visitor parking is limited to slots 1-10.'),
      'text/plain',
    );
    expect(text).toBe('Visitor parking is limited to slots 1-10.');
  });

  it('reads text/markdown as UTF-8 as-is', async () => {
    const text = await extractText(Buffer.from('# Bye-Laws\n\nRule 1.'), 'text/markdown');
    expect(text).toBe('# Bye-Laws\n\nRule 1.');
  });

  it('rejects an unsupported mimetype', async () => {
    await expect(extractText(Buffer.from('x'), 'application/zip')).rejects.toThrow(
      /Unsupported file type/,
    );
  });
});
