/**
 * memory/conversationStore.ts
 *
 * Postgres-backed conversation memory (HLD Sec 7.6, architecture diagram in
 * Sec 4: OpenClaw Gateway -> Memory Layer -> PostgreSQL). Stores every
 * inbound/outbound WhatsApp message against its thread, and hands back a
 * configurable recent-history window shaped for direct injection into a
 * Gemini prompt — the "remember previous conversations" objective in HLD
 * Sec 2.
 */
import { desc, eq } from 'drizzle-orm';
import { getPostgresClient, type Database } from './postgresAdapter.js';
import { conversations, messages } from '../db/schema.js';

/** Default recent-message window injected into the Gemini prompt (HLD Sec 7.6). */
export const DEFAULT_HISTORY_WINDOW = 20;
/** Hard ceiling regardless of what a caller requests, so a bad limit can't turn into an unbounded query. */
export const MAX_HISTORY_WINDOW = 200;

export type MessageDirection = 'in' | 'out';
export type MessageSenderType = 'resident' | 'ai' | 'secretary';

export interface AppendMessageInput {
  residentId: string;
  whatsappThreadId: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  body: string;
  mediaUrl?: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  body: string;
  mediaUrl: string | null;
  createdAt: Date;
}

/** Structurally compatible with @google/generative-ai's `Content` type. */
export interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

/**
 * Clamps a requested history window to `(0, MAX_HISTORY_WINDOW]`, falling
 * back to `fallback` (default `DEFAULT_HISTORY_WINDOW`) for anything
 * missing, non-finite, or non-positive. Pure — see conversationStore.test.ts.
 */
export function clampHistoryWindow(
  limit: number | undefined,
  fallback: number = DEFAULT_HISTORY_WINDOW,
): number {
  const candidate = limit ?? fallback;
  if (!Number.isFinite(candidate) || candidate <= 0) return fallback;
  return Math.min(Math.floor(candidate), MAX_HISTORY_WINDOW);
}

/**
 * Converts stored messages (oldest first) into Gemini `Content[]` for prompt
 * injection. Resident messages become `user` turns, AI messages become
 * `model` turns. Gemini only has those two roles, so secretary messages —
 * which do occur in a resident thread when the secretary steps in — are
 * folded into `user` turns with a `[Secretary]:` prefix rather than dropped,
 * so the model still sees them but can't mistake them for its own prior
 * output. Pure — see conversationStore.test.ts.
 */
export function toGeminiContents(
  messagesOldestFirst: readonly ConversationMessage[],
): GeminiContent[] {
  return messagesOldestFirst.map((m) => {
    if (m.senderType === 'ai') {
      return { role: 'model', parts: [{ text: m.body }] };
    }
    if (m.senderType === 'secretary') {
      return { role: 'user', parts: [{ text: `[Secretary]: ${m.body}` }] };
    }
    return { role: 'user', parts: [{ text: m.body }] };
  });
}

export class ConversationStore {
  constructor(
    private readonly db: Database = getPostgresClient(),
    private readonly defaultWindow: number = DEFAULT_HISTORY_WINDOW,
  ) {}

  /**
   * Finds the conversation for a WhatsApp thread, creating it if this is the
   * first message on it. One round trip via upsert-on-unique-thread-id.
   */
  async getOrCreateConversation(residentId: string, whatsappThreadId: string): Promise<string> {
    const [row] = await this.db
      .insert(conversations)
      .values({ residentId, whatsappThreadId })
      .onConflictDoUpdate({
        target: conversations.whatsappThreadId,
        // residentId shouldn't actually change for an existing thread; this
        // no-op-in-practice `set` only exists because onConflictDoUpdate
        // requires one — it's what makes the insert an upsert instead of a
        // plain insert-or-fail.
        set: { residentId },
      })
      .returning({ id: conversations.id });

    if (!row) throw new Error('Failed to get or create conversation.');
    return row.id;
  }

  /** Appends a message to a resident's thread and bumps `conversations.last_message_at`. */
  async appendMessage(input: AppendMessageInput): Promise<ConversationMessage> {
    const conversationId = await this.getOrCreateConversation(
      input.residentId,
      input.whatsappThreadId,
    );

    const [row] = await this.db
      .insert(messages)
      .values({
        conversationId,
        direction: input.direction,
        senderType: input.senderType,
        body: input.body,
        mediaUrl: input.mediaUrl ?? null,
      })
      .returning();

    if (!row) throw new Error('Failed to append message.');

    await this.db
      .update(conversations)
      .set({ lastMessageAt: row.createdAt })
      .where(eq(conversations.id, conversationId));

    return row;
  }

  /**
   * Returns the most recent `limit` messages (default `defaultWindow`, i.e.
   * 20 per HLD Sec 7.6) for a WhatsApp thread, oldest first — ready to feed
   * straight into `toGeminiContents`. Returns `[]` for an unknown thread
   * rather than throwing, since "no history yet" is the normal first-message
   * case.
   */
  async getRecentMessages(
    whatsappThreadId: string,
    limit?: number,
  ): Promise<ConversationMessage[]> {
    const window = clampHistoryWindow(limit, this.defaultWindow);

    const [conversation] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.whatsappThreadId, whatsappThreadId))
      .limit(1);
    if (!conversation) return [];

    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(desc(messages.createdAt))
      .limit(window);

    return rows.reverse(); // most-recent-first from SQL -> chronological for prompt injection
  }

  /** Convenience wrapper: recent history, already shaped for a Gemini prompt. */
  async getRecentHistoryForPrompt(
    whatsappThreadId: string,
    limit?: number,
  ): Promise<GeminiContent[]> {
    return toGeminiContents(await this.getRecentMessages(whatsappThreadId, limit));
  }
}

export function createConversationStore(
  db: Database = getPostgresClient(),
  defaultWindow: number = DEFAULT_HISTORY_WINDOW,
): ConversationStore {
  return new ConversationStore(db, defaultWindow);
}
