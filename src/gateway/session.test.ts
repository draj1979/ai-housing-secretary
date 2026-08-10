import { describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore } from './session.js';

describe('InMemorySessionStore', () => {
  it('creates a new session on first contact', async () => {
    const store = new InMemorySessionStore(1800);
    const session = await store.getOrCreateSession({
      phoneE164: '+919820011002',
      role: 'resident',
      whatsappThreadId: '919820011002',
      residentId: 'resident-1',
    });

    expect(session.resumed).toBe(false);
    expect(session.phoneE164).toBe('+919820011002');
    expect(session.role).toBe('resident');
    expect(session.residentId).toBe('resident-1');
    expect(session.sessionId).toBeTruthy();
    expect(session.createdAt).toBe(session.lastActiveAt);
  });

  it('resumes the same session (same sessionId) on the next message within the idle window', async () => {
    const store = new InMemorySessionStore(1800);
    const first = await store.getOrCreateSession({
      phoneE164: '+919820011002',
      role: 'resident',
      whatsappThreadId: '919820011002',
    });
    const second = await store.getOrCreateSession({
      phoneE164: '+919820011002',
      role: 'resident',
      whatsappThreadId: '919820011002',
    });

    expect(second.resumed).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('creates a fresh session (new sessionId) once the idle timeout has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemorySessionStore(60); // 60s idle timeout
      const first = await store.getOrCreateSession({
        phoneE164: '+919820011002',
        role: 'resident',
        whatsappThreadId: '919820011002',
      });

      vi.advanceTimersByTime(61_000);

      const second = await store.getOrCreateSession({
        phoneE164: '+919820011002',
        role: 'resident',
        whatsappThreadId: '919820011002',
      });

      expect(second.resumed).toBe(false);
      expect(second.sessionId).not.toBe(first.sessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sessions for different phone numbers independent', async () => {
    const store = new InMemorySessionStore(1800);
    const a = await store.getOrCreateSession({
      phoneE164: '+919820011001',
      role: 'resident',
      whatsappThreadId: '919820011001',
    });
    const b = await store.getOrCreateSession({
      phoneE164: '+919820011002',
      role: 'resident',
      whatsappThreadId: '919820011002',
    });

    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('distinguishes resident and secretary roles', async () => {
    const store = new InMemorySessionStore(1800);
    const secretary = await store.getOrCreateSession({
      phoneE164: '+919820099000',
      role: 'secretary',
      whatsappThreadId: '919820099000',
    });
    expect(secretary.role).toBe('secretary');
    expect(secretary.residentId).toBeUndefined();
  });

  it('endSession removes the session so the next call creates a fresh one', async () => {
    const store = new InMemorySessionStore(1800);
    const first = await store.getOrCreateSession({
      phoneE164: '+919820011002',
      role: 'resident',
      whatsappThreadId: '919820011002',
    });

    await store.endSession('+919820011002');

    const second = await store.getOrCreateSession({
      phoneE164: '+919820011002',
      role: 'resident',
      whatsappThreadId: '919820011002',
    });
    expect(second.resumed).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});
