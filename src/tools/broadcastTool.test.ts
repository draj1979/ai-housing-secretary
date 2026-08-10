import { describe, expect, it } from 'vitest';
import { decodeAttachment, encodeAttachment } from './broadcastTool.js';

// DB-touching behavior (draftAnnouncement, approveAndSend, the scheduling
// transitions) is exercised via modules/broadcast.test.ts against a mocked
// BroadcastTool, and verified live against real Postgres — same testing
// split as tools/complaintTool.ts (see docs/broadcast-management.md).
// Only the pure encode/decode round-trip is unit-tested here.

describe('encodeAttachment / decodeAttachment', () => {
  it('round-trips an image attachment', () => {
    const encoded = encodeAttachment({ type: 'image', mediaId: 'media-123' });
    expect(encoded).toBe('image:media-123');
    expect(decodeAttachment(encoded)).toEqual({ type: 'image', mediaId: 'media-123' });
  });

  it('round-trips a document attachment with a filename', () => {
    const encoded = encodeAttachment({
      type: 'document',
      mediaId: 'media-456',
      filename: 'agm-notice.pdf',
    });
    expect(encoded).toBe('document:media-456:agm-notice.pdf');
    expect(decodeAttachment(encoded)).toEqual({
      type: 'document',
      mediaId: 'media-456',
      filename: 'agm-notice.pdf',
    });
  });

  it('defaults a document with no filename to "document.pdf" on encode', () => {
    const encoded = encodeAttachment({ type: 'document', mediaId: 'media-789' });
    expect(encoded).toBe('document:media-789:document.pdf');
  });

  it('decodes an unprefixed/unknown-type string as an image (safe default)', () => {
    expect(decodeAttachment('media-only')).toEqual({ type: 'image', mediaId: '' });
  });
});
