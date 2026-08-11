import { describe, expect, it } from 'vitest';
import { objectPathFromGcsUri } from './documentStorage.js';

describe('objectPathFromGcsUri', () => {
  it('extracts the object path from a gs:// URI', () => {
    expect(objectPathFromGcsUri('gs://my-bucket/documents/abc-bye-laws.pdf')).toBe(
      'documents/abc-bye-laws.pdf',
    );
  });

  it('handles nested paths', () => {
    expect(objectPathFromGcsUri('gs://my-bucket/a/b/c.txt')).toBe('a/b/c.txt');
  });

  it('returns null for a non-gs:// URI', () => {
    expect(objectPathFromGcsUri('https://example.com/file.pdf')).toBeNull();
    expect(objectPathFromGcsUri('docs/knowledge/bye-laws.md')).toBeNull();
  });
});
