/**
 * gateway/session.ts
 *
 * OpenClaw Gateway session management (HLD Sec 7.1: "Session management").
 * Maps each WhatsApp thread to a session keyed by `phone_e164`, with an
 * idle timeout and resume-on-next-message: if the resident (or secretary)
 * messages again before the session expires, the *same* session is
 * returned (`resumed: true`) and its idle timer resets; otherwise a fresh
 * session is created. This is separate from — and much shorter-lived than —
 * memory/conversationStore.ts's permanent Postgres conversation history:
 * a session is "is this an ongoing interaction right now", not "what was
 * ever said".
 *
 * Redis-backed (`RedisSessionStore`) for production — TTL is the natural
 * mechanism for an idle timeout. `InMemorySessionStore` implements the same
 * interface for tests, same pattern as memory/vectorStore.ts's
 * InMemoryVectorStore.
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadEnv, type Env } from '../config/env.js';

export type SessionRole = 'resident' | 'secretary';

export interface GatewaySession {
  sessionId: string;
  phoneE164: string;
  role: SessionRole;
  whatsappThreadId: string;
  residentId?: string;
  /** ISO timestamp of session creation (unchanged across resumes). */
  createdAt: string;
  /** ISO timestamp of this access (updated on every resume). */
  lastActiveAt: string;
  /** True if an existing, still-live session was resumed rather than a new one created. */
  resumed: boolean;
}

export interface GetOrCreateSessionInput {
  phoneE164: string;
  role: SessionRole;
  whatsappThreadId: string;
  residentId?: string;
}

export interface SessionStore {
  getOrCreateSession(input: GetOrCreateSessionInput): Promise<GatewaySession>;
  /** Ends a session early (e.g. on an explicit "done"/"cancel" from the user). */
  endSession(phoneE164: string): Promise<void>;
  close(): Promise<void>;
}

const SESSION_KEY_PREFIX = 'ahs:session:';

function sessionKey(phoneE164: string): string {
  return `${SESSION_KEY_PREFIX}${phoneE164}`;
}

/** Redis-backed session store — TTL (SESSION_IDLE_TIMEOUT_SECONDS) is the idle timeout. */
export class RedisSessionStore implements SessionStore {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor(env: Env = loadEnv()) {
    this.redis = new Redis(env.REDIS_URL);
    this.ttlSeconds = env.SESSION_IDLE_TIMEOUT_SECONDS;
  }

  async getOrCreateSession(input: GetOrCreateSessionInput): Promise<GatewaySession> {
    const key = sessionKey(input.phoneE164);
    const existingRaw = await this.redis.get(key);
    const now = new Date().toISOString();

    if (existingRaw) {
      const existing = JSON.parse(existingRaw) as GatewaySession;
      const resumed: GatewaySession = { ...existing, lastActiveAt: now, resumed: true };
      // Refresh the idle timer — this is what makes it an *idle* timeout
      // rather than a fixed session lifetime.
      await this.redis.set(key, JSON.stringify(resumed), 'EX', this.ttlSeconds);
      return resumed;
    }

    const created: GatewaySession = {
      sessionId: randomUUID(),
      phoneE164: input.phoneE164,
      role: input.role,
      whatsappThreadId: input.whatsappThreadId,
      ...(input.residentId ? { residentId: input.residentId } : {}),
      createdAt: now,
      lastActiveAt: now,
      resumed: false,
    };
    await this.redis.set(key, JSON.stringify(created), 'EX', this.ttlSeconds);
    return created;
  }

  async endSession(phoneE164: string): Promise<void> {
    await this.redis.del(sessionKey(phoneE164));
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export function createRedisSessionStore(env: Env = loadEnv()): SessionStore {
  return new RedisSessionStore(env);
}

/** In-process session store for tests — same idle-timeout/resume semantics, no Redis required. */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { session: GatewaySession; expiresAt: number }>();

  constructor(private readonly ttlSeconds: number = 1800) {}

  async getOrCreateSession(input: GetOrCreateSessionInput): Promise<GatewaySession> {
    const key = sessionKey(input.phoneE164);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const entry = this.sessions.get(key);

    if (entry && entry.expiresAt > now) {
      const resumed: GatewaySession = { ...entry.session, lastActiveAt: nowIso, resumed: true };
      this.sessions.set(key, { session: resumed, expiresAt: now + this.ttlSeconds * 1000 });
      return resumed;
    }

    const created: GatewaySession = {
      sessionId: randomUUID(),
      phoneE164: input.phoneE164,
      role: input.role,
      whatsappThreadId: input.whatsappThreadId,
      ...(input.residentId ? { residentId: input.residentId } : {}),
      createdAt: nowIso,
      lastActiveAt: nowIso,
      resumed: false,
    };
    this.sessions.set(key, { session: created, expiresAt: now + this.ttlSeconds * 1000 });
    return created;
  }

  async endSession(phoneE164: string): Promise<void> {
    this.sessions.delete(sessionKey(phoneE164));
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }
}
