/**
 * db/schema.ts
 *
 * Drizzle ORM schema for PostgreSQL (HLD Sec 5, 7.5, 7.6). Chosen over Prisma
 * for lighter runtime footprint on the single GCP Compute Engine VM described
 * in Sec 13/14.
 *
 * See docs/db-schema.md for a table-by-table explanation tied back to the
 * HLD's functional modules (Sec 6) and resident database (Sec 7.5).
 *
 * After changing this file, regenerate the SQL migration with:
 *   pnpm db:generate
 */
import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// NOTE: duplicated (not imported) from config/constants.ts SUGGESTION_CATEGORIES.
// drizzle-kit's CJS schema loader cannot resolve cross-file ESM ".js" imports
// out of this "type": "module" package, so the enum values are inlined here.
// Kept in sync by src/db/schema.test.ts — update both places together.
const SUGGESTION_CATEGORY_VALUES = ['maintenance', 'security', 'amenities', 'finance'] as const;

// NOTE: duplicated (not imported) from config/constants.ts ESCALATION_CATEGORIES,
// for the same drizzle-kit CJS-loader reason as above. Kept in sync by
// src/db/schema.test.ts — update both places together.
const ESCALATION_CATEGORY_VALUES = [
  'financial_dispute',
  'legal_matter',
  'committee_decision',
  'abuse',
  'unknown_question',
] as const;

// NOTE: duplicated (not imported) from memory/embeddings.ts EMBEDDING_DIMENSIONS,
// for the same drizzle-kit CJS-loader reason as above. Kept in sync by
// src/db/schema.test.ts. Gemini's gemini-embedding-001 (config/env.ts
// EMBEDDING_MODEL default) outputs 3072-dimensional vectors — see
// memory/embeddings.ts's own header comment for why (text-embedding-004,
// which output 768, was shut down 2026-01-14).
const EMBEDDING_DIMENSIONS = 3072;

/**
 * pgvector `vector(n)` column type (HLD Sec 5, 7.4). Requires the `vector`
 * extension — enabled by the first statement of
 * src/db/migrations/0001_knowledge_chunks.sql, not by drizzle-kit (it has no
 * concept of extensions).
 */
const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? EMBEDDING_DIMENSIONS})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(',')
      .filter((v) => v.length > 0)
      .map(Number);
  },
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const messageDirectionEnum = pgEnum('message_direction', ['in', 'out']);

export const senderTypeEnum = pgEnum('sender_type', ['resident', 'ai', 'secretary']);

export const complaintStatusEnum = pgEnum('complaint_status', [
  'open',
  'in_progress',
  'resolved',
  'escalated',
]);

export const suggestionCategoryEnum = pgEnum('suggestion_category', SUGGESTION_CATEGORY_VALUES);

export const announcementStatusEnum = pgEnum('announcement_status', [
  'draft',
  'pending_approval',
  'approved',
  'broadcast',
]);

export const escalationSourceTypeEnum = pgEnum('escalation_source_type', [
  'complaint',
  'query',
  'suggestion',
]);

export const escalationStatusEnum = pgEnum('escalation_status', [
  'pending',
  'acknowledged',
  'resolved',
]);

export const escalationCategoryEnum = pgEnum('escalation_category', ESCALATION_CATEGORY_VALUES);

export const auditActorTypeEnum = pgEnum('audit_actor_type', [
  'resident',
  'ai',
  'secretary',
  'system',
]);

// ---------------------------------------------------------------------------
// residents — HLD Sec 7.5 (Resident Database)
// ---------------------------------------------------------------------------

export const residents = pgTable(
  'residents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    flatNumber: varchar('flat_number', { length: 20 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    // Field-level encryption at rest (HLD Sec 15) — AES-256-GCM ciphertext
    // (security/fieldEncryption.ts), NOT a plaintext phone number. Widened
    // from 20 to fit iv+authTag+ciphertext, base64-encoded. Never queried
    // directly — see phoneE164Hash below and tools/residentsTool.ts, the
    // only code allowed to read/write this column.
    phoneE164: varchar('phone_e164', { length: 255 }).notNull(),
    // Deterministic HMAC-SHA256 "blind index" of the plaintext phone
    // number (security/fieldEncryption.ts's hashForLookup) — this, not
    // phoneE164 itself, is what every lookup-by-phone-number queries and
    // what the uniqueness constraint is actually on.
    phoneE164Hash: varchar('phone_e164_hash', { length: 64 }).notNull(),
    // e.g. ["MH12AB1234", "MH12CD5678"]
    vehicles: text('vehicles').array().notNull().default([]),
    // Also field-level encrypted at rest (HLD Sec 15) — never a lookup
    // key, so no hash column needed for this one.
    emergencyContact: varchar('emergency_contact', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    phoneE164HashIdx: uniqueIndex('residents_phone_e164_hash_idx').on(table.phoneE164Hash),
    flatNumberIdx: index('residents_flat_number_idx').on(table.flatNumber),
  }),
);

export const residentsRelations = relations(residents, ({ many }) => ({
  conversations: many(conversations),
  complaints: many(complaints),
  suggestions: many(suggestions),
}));

// ---------------------------------------------------------------------------
// conversations — HLD Sec 7.6 (Memory Layer: conversation history)
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    residentId: uuid('resident_id')
      .notNull()
      .references(() => residents.id, { onDelete: 'cascade' }),
    whatsappThreadId: varchar('whatsapp_thread_id', { length: 100 }).notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    whatsappThreadIdIdx: uniqueIndex('conversations_whatsapp_thread_id_idx').on(
      table.whatsappThreadId,
    ),
    residentIdIdx: index('conversations_resident_id_idx').on(table.residentId),
    lastMessageAtIdx: index('conversations_last_message_at_idx').on(table.lastMessageAt),
  }),
);

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  resident: one(residents, {
    fields: [conversations.residentId],
    references: [residents.id],
  }),
  messages: many(messages),
}));

// ---------------------------------------------------------------------------
// messages — HLD Sec 7.6 (Memory Layer: conversation history)
// ---------------------------------------------------------------------------

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: messageDirectionEnum('direction').notNull(),
    senderType: senderTypeEnum('sender_type').notNull(),
    body: text('body').notNull(),
    mediaUrl: text('media_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationIdIdx: index('messages_conversation_id_idx').on(table.conversationId),
    createdAtIdx: index('messages_created_at_idx').on(table.createdAt),
  }),
);

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

// ---------------------------------------------------------------------------
// complaints — HLD Sec 6.3, 11 (Complaint Management)
// ---------------------------------------------------------------------------

export const complaints = pgTable(
  'complaints',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Human-readable ticket, e.g. TCK-2026-0001 (HLD Sec 6.3: "Generates Ticket ID")
    ticketId: varchar('ticket_id', { length: 32 }).notNull(),
    residentId: uuid('resident_id')
      .notNull()
      .references(() => residents.id, { onDelete: 'restrict' }),
    flatNumber: varchar('flat_number', { length: 20 }).notNull(),
    category: varchar('category', { length: 50 }).notNull(),
    description: text('description').notNull(),
    status: complaintStatusEnum('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => ({
    ticketIdIdx: uniqueIndex('complaints_ticket_id_idx').on(table.ticketId),
    // Polled by the secretary-notification job and dashboards (HLD Sec 6.3, 11).
    statusIdx: index('complaints_status_idx').on(table.status),
    residentIdIdx: index('complaints_resident_id_idx').on(table.residentId),
  }),
);

export const complaintsRelations = relations(complaints, ({ one, many }) => ({
  resident: one(residents, {
    fields: [complaints.residentId],
    references: [residents.id],
  }),
  escalations: many(escalations),
}));

// ---------------------------------------------------------------------------
// suggestions — HLD Sec 6.4 (Suggestion Management)
// ---------------------------------------------------------------------------

export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    residentId: uuid('resident_id')
      .notNull()
      .references(() => residents.id, { onDelete: 'cascade' }),
    category: suggestionCategoryEnum('category').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    residentIdIdx: index('suggestions_resident_id_idx').on(table.residentId),
    categoryIdx: index('suggestions_category_idx').on(table.category),
  }),
);

export const suggestionsRelations = relations(suggestions, ({ one }) => ({
  resident: one(residents, {
    fields: [suggestions.residentId],
    references: [residents.id],
  }),
}));

// ---------------------------------------------------------------------------
// announcements — HLD Sec 6.1, 9 (Broadcast Management)
// ---------------------------------------------------------------------------

export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Secretary identity (phone_e164 or name) who authored the draft.
    author: varchar('author', { length: 200 }).notNull(),
    body: text('body').notNull(),
    mediaUrls: text('media_urls').array().notNull().default([]),
    status: announcementStatusEnum('status').notNull().default('draft'),
    approvedBy: varchar('approved_by', { length: 200 }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    broadcastAt: timestamp('broadcast_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Polled by the scheduler to find due drafts/approvals (HLD Sec 6.1, 9;
    // <30s broadcast time NFR — see config/constants.ts NFR_TARGETS).
    statusIdx: index('announcements_status_idx').on(table.status),
    scheduledAtIdx: index('announcements_scheduled_at_idx').on(table.scheduledAt),
  }),
);

// ---------------------------------------------------------------------------
// escalations — HLD Sec 6.5, 16 (Escalation Engine)
// ---------------------------------------------------------------------------

export const escalations = pgTable(
  'escalations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceType: escalationSourceTypeEnum('source_type').notNull(),
    // Polymorphic reference to complaints.id / a query log id / suggestions.id
    // depending on sourceType — intentionally not a FK since it spans tables.
    sourceId: uuid('source_id').notNull(),
    reason: text('reason').notNull(),
    // What kind of human decision this needs (HLD Sec 6.5) — see
    // config/constants.ts ESCALATION_CATEGORIES / modules/escalation.ts.
    // Defaulted rather than left nullable so `modules/escalation.ts`'s
    // fallback categorization is never required to backfill a NULL.
    category: escalationCategoryEnum('category').notNull().default('committee_decision'),
    status: escalationStatusEnum('status').notNull().default('pending'),
    notifiedSecretaryAt: timestamp('notified_secretary_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Polled by the secretary-notification job (HLD Sec 6.5).
    statusIdx: index('escalations_status_idx').on(table.status),
    sourceIdx: index('escalations_source_idx').on(table.sourceType, table.sourceId),
  }),
);

export const escalationsRelations = relations(escalations, ({ one }) => ({
  complaint: one(complaints, {
    fields: [escalations.sourceId],
    references: [complaints.id],
  }),
}));

// ---------------------------------------------------------------------------
// knowledge_documents — HLD Sec 6.2, 7.4 (Knowledge Base)
// ---------------------------------------------------------------------------

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: varchar('title', { length: 300 }).notNull(),
    // e.g. handbook | bye_laws | parking_policy | emergency_contacts |
    // maintenance_rules | clubhouse_rules (HLD Sec 7.4)
    category: varchar('category', { length: 50 }).notNull(),
    // GCS object path or external URL to the source document (embeddings
    // live separately in the vector store — see memory/vectorStore.ts)
    sourceUri: text('source_uri').notNull(),
    version: integer('version').notNull().default(1),
    // sha256 of the last-ingested content, so scripts/ingest-knowledge.ts
    // can tell "unchanged" from "needs a version bump + re-embedding"
    // without diffing full text on every run.
    contentHash: varchar('content_hash', { length: 64 }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    categoryIdx: index('knowledge_documents_category_idx').on(table.category),
    sourceUriIdx: uniqueIndex('knowledge_documents_source_uri_idx').on(table.sourceUri),
  }),
);

export const knowledgeDocumentsRelations = relations(knowledgeDocuments, ({ many }) => ({
  chunks: many(knowledgeChunks),
}));

// ---------------------------------------------------------------------------
// knowledge_chunks — HLD Sec 6.2, 7.4 (Knowledge Base — vector store rows)
// ---------------------------------------------------------------------------
// Backs memory/vectorStore.ts's PgVectorStore. Populated by
// scripts/ingest-knowledge.ts. When VECTOR_DB_PROVIDER=chroma this table is
// still written (so knowledge_documents provenance stays queryable from SQL)
// but similarity search itself goes to Chroma instead of this table.

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    // Denormalized copy of knowledge_documents.category so PgVectorStore can
    // filter without a join, mirroring the metadata Chroma stores per-chunk.
    category: varchar('category', { length: 50 }),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentChunkIdx: uniqueIndex('knowledge_chunks_document_chunk_idx').on(
      table.documentId,
      table.chunkIndex,
    ),
    documentIdIdx: index('knowledge_chunks_document_id_idx').on(table.documentId),
    categoryIdx: index('knowledge_chunks_category_idx').on(table.category),
  }),
);

export const knowledgeChunksRelations = relations(knowledgeChunks, ({ one }) => ({
  document: one(knowledgeDocuments, {
    fields: [knowledgeChunks.documentId],
    references: [knowledgeDocuments.id],
  }),
}));

// ---------------------------------------------------------------------------
// audit_logs — HLD Sec 15 (Security: Audit Logs)
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    // resident id, "ai-secretary", or secretary phone/name depending on actorType.
    actorId: varchar('actor_id', { length: 200 }),
    action: varchar('action', { length: 100 }).notNull(),
    entity: varchar('entity', { length: 100 }).notNull(),
    entityId: varchar('entity_id', { length: 100 }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entityIdx: index('audit_logs_entity_idx').on(table.entity, table.entityId),
    createdAtIdx: index('audit_logs_created_at_idx').on(table.createdAt),
    actorTypeIdx: index('audit_logs_actor_type_idx').on(table.actorType),
  }),
);
