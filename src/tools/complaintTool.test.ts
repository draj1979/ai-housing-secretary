import { describe, expect, it } from 'vitest';
import { formatTicketId } from './complaintTool.js';

describe('formatTicketId', () => {
  it('formats as TCK-{year}-{4-digit zero-padded sequence}', () => {
    expect(formatTicketId(2026, 1)).toBe('TCK-2026-0001');
    expect(formatTicketId(2026, 42)).toBe('TCK-2026-0042');
    expect(formatTicketId(2026, 9999)).toBe('TCK-2026-9999');
  });

  it('does not truncate a sequence number wider than 4 digits (grows instead of colliding)', () => {
    expect(formatTicketId(2026, 10000)).toBe('TCK-2026-10000');
  });

  it('produces unique ids for a run of consecutive sequence numbers in the same year', () => {
    const ids = Array.from({ length: 500 }, (_, i) => formatTicketId(2026, i + 1));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces distinct ids across years for the same sequence number', () => {
    expect(formatTicketId(2026, 1)).not.toBe(formatTicketId(2027, 1));
  });

  it('rejects a non-positive sequence number', () => {
    expect(() => formatTicketId(2026, 0)).toThrow();
    expect(() => formatTicketId(2026, -1)).toThrow();
  });
});
