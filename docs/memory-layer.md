# Memory Layer

Implements HLD Sec 7.6 (Memory Layer) and the Sec 4 architecture diagram's
`OpenClaw Gateway -> Memory Layer -> PostgreSQL / Vector DB -> Gemini API`
path. Two independent halves, both under `src/memory/`:

1. **Conversation memory** — `conversationStore.ts`, Postgres-backed,
   "remember previous conversations" (HLD Sec 2).
2. **Knowledge Base vector store** — `vectorStore.ts` + `embeddings.ts` +
   `chunking.ts`, backing FAQ search over society documents (HLD Sec 6.2,
   7.4), populated by `scripts/ingest-knowledge.ts`.

## 1. Conversation memory (`conversationStore.ts`)

Every inbound/outbound WhatsApp message is written to the `messages` table
against a `conversations` row keyed by `whatsapp_thread_id` (see
[`docs/db-schema.md`](db-schema.md)). `ConversationStore` exposes:

- `getOrCreateConversation(residentId, whatsappThreadId)` — one-round-trip
  upsert on the thread's unique id.
- `appendMessage(input)` — inserts a message and bumps
  `conversations.last_message_at`.
- `getRecentMessages(whatsappThreadId, limit?)` — the most recent `limit`
  messages (default **20**, HLD Sec 7.6), returned oldest-first.
- `getRecentHistoryForPrompt(whatsappThreadId, limit?)` — the above, already
  shaped as Gemini `Content[]` via `toGeminiContents`.

`clampHistoryWindow` and `toGeminiContents` are pure functions (no DB),
exported specifically so the window logic and role-mapping can be unit
tested without a database — see `conversationStore.test.ts`.

**Role mapping into Gemini's two-role model:** Gemini only has `user` and
`model` roles. `senderType: 'resident'` messages become `user`, `'ai'`
becomes `model`. `'secretary'` messages (the secretary stepping into a
resident thread) are folded into `user` turns with a `[Secretary]:` prefix
rather than dropped — the model needs that context, but must not mistake it
for its own prior output.

**Window default and cap:** `DEFAULT_HISTORY_WINDOW = 20` matches the task
spec; `MAX_HISTORY_WINDOW = 200` is a hard ceiling so a caller passing a bad
value (e.g. `Infinity`) can't turn `getRecentMessages` into an unbounded
query — `clampHistoryWindow` enforces both.

## 2. Knowledge Base vector store (`vectorStore.ts`)

`VectorStore` is a small interface — `upsertChunks`, `deleteDocumentChunks`,
`query` — implemented three ways:

| Implementation        | Backing                                                        | Used for                                                                                                                                |
| --------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PgVectorStore`       | Postgres `knowledge_chunks` table + `pgvector` extension       | **Default production provider** (`VECTOR_DB_PROVIDER=pgvector`) — no extra service, we're already running Postgres for everything else. |
| `ChromaVectorStore`   | Chroma server (`docker/docker-compose.yml`'s `chroma` profile) | Alternate provider (`VECTOR_DB_PROVIDER=chroma`), same interface.                                                                       |
| `InMemoryVectorStore` | In-process `Map`                                               | Unit tests only (`vectorStore.test.ts`) — not a supported production provider.                                                          |

`createVectorStore(env?)` picks the implementation from
`config/env.ts`'s `VECTOR_DB_PROVIDER`. All three report scores on the same
scale — cosine similarity, higher is more relevant — via
`src/memory/similarity.ts`'s `cosineSimilarity`/`rankTopK`:

- `PgVectorStore` computes `1 - (embedding <=> query::vector)` in SQL
  (pgvector's `<=>` is cosine _distance_).
- `ChromaVectorStore` creates its collection with `"hnsw:space": "cosine"`
  and converts Chroma's returned distance the same way.
- `InMemoryVectorStore` calls `rankTopK` directly.

So a caller (the eventual `tools/knowledgeSearchTool.ts`) never needs a
provider-specific branch.

**Chroma always gets pre-computed embeddings.** `ChromaVectorStore` passes
an `IEmbeddingFunction` stub that throws if Chroma ever tries to embed text
itself — we always supply Gemini embeddings via `embeddings.ts`, and a
silent fallback to Chroma's local onnx default model would quietly produce
vectors in the wrong space (and download a model at runtime). Chroma
metadata values must be primitives, so free-form chunk `metadata` is
JSON-stringified into a single `metadataJson` field and parsed back on read.

### Embeddings (`embeddings.ts`)

Wraps Gemini's `text-embedding-004` (`config/env.ts` `EMBEDDING_MODEL`).
Two task types matter: content being **stored** is embedded as
`RETRIEVAL_DOCUMENT`, content being **searched for** as `RETRIEVAL_QUERY` —
Gemini optimizes the vector space differently for each, so
`embedText`/`embedBatch` take an explicit `'document' | 'query'` purpose
rather than a single embed function. `EMBEDDING_DIMENSIONS = 768` here is
the canonical source of truth for the vector column width.

### Chunking (`chunking.ts`)

Pure, dependency-free `chunkText(text, options?)`:

1. Split on paragraph boundaries (blank lines) — the natural unit for a
   handbook/bye-laws document.
2. Any paragraph still over `maxChunkChars` (default 1000) is split on
   sentence boundaries.
3. Any "sentence" still over the limit (no punctuation at all) is hard-split
   by character count — a guaranteed-terminating fallback.
4. Units are greedily packed into chunks up to `maxChunkChars`, with the
   tail of each chunk repeated at the start of the next
   (`overlapChars`, default 150) so a fact split across a boundary is still
   findable from either side.

Edge case worth knowing: if a single paragraph alone is bigger than
`overlapChars`, the packer cannot produce partial-unit overlap without
looping forever on that boundary, so it takes zero overlap there instead —
covered explicitly in `chunking.test.ts`.

### Two-column schema, one document per row (`knowledge_documents` + `knowledge_chunks`)

`knowledge_documents` is document-level provenance (title, category,
`source_uri`, `version`, `content_hash`); `knowledge_chunks` is one row per
embedded chunk, FK'd to it. See [`docs/db-schema.md`](db-schema.md) for the
column-level rationale.

## 3. Ingestion (`scripts/ingest-knowledge.ts`)

```bash
pnpm knowledge:ingest
```

For each `.md` file in `/docs/knowledge` (Society Handbook, Bye-Laws,
Parking Policy, Emergency Contacts, Maintenance Rules, Clubhouse Rules —
HLD Sec 7.4's exact list, mapped to categories via `KNOWLEDGE_CATEGORIES`):

1. Read the file, derive a title (first markdown `#` heading, else the
   filename), and hash its content (sha256).
2. Look up the existing `knowledge_documents` row by `source_uri`. If the
   hash matches, skip re-chunking/re-embedding entirely (cheap no-op re-run).
3. Otherwise: `chunkText()` the content, `embedBatch()` the chunks
   (`purpose: 'document'`), `deleteDocumentChunks()` any old chunks for that
   document, then `upsertChunks()` the new ones — and bump
   `knowledge_documents.version` + `content_hash`.

Idempotent by design: safe to re-run after editing a policy doc, or on a
schedule, without duplicating chunks or wasting embedding calls on unchanged
files.

## Sample knowledge base

`/docs/knowledge/*.md` are original sample documents for a fictional
society ("Sunrise Meadows CHS") covering all six HLD Sec 7.4 categories, so
the ingestion pipeline has real, realistic content to chunk rather than
placeholder text. Chunked locally (no API key needed) as a sanity check,
each file produced 3–6 chunks of 500–1000 characters — see the "Verified"
note below.

## Testing strategy

- **Pure logic, no infra** (`chunking.test.ts`, `similarity.test.ts`,
  `conversationStore.test.ts`'s `clampHistoryWindow`/`toGeminiContents`
  tests): run in `pnpm test`, no database or network required.
- **Retrieval / top-k similarity search** (`vectorStore.test.ts`): exercises
  the full `VectorStore` contract — upsert, category filter, delete,
  metadata round-trip, top-k ranking — against `InMemoryVectorStore`, which
  implements the exact same interface `PgVectorStore`/`ChromaVectorStore`
  do, just without a live backend. This is what "unit tests for retrieval"
  means here: the ranking algorithm and interface contract are fully
  covered without needing Postgres or Chroma running in CI.
- **Live integration, done once in this session, not part of `pnpm test`:**
  a throwaway `pgvector/pgvector:pg16` container was migrated and seeded,
  then `ConversationStore` (append → recent-window → Gemini-shaped output,
  including the `[Secretary]:` prefix and window clamping) and
  `PgVectorStore` (upsert → top-k query → category filter → cascade delete
  via FK) were both exercised directly against it — all correct. A
  throwaway `chromadb/chroma:latest` container (the same image
  `docker/docker-compose.yml` uses) was also stood up and
  `ChromaVectorStore` exercised the same way — upsert, top-k query,
  metadata round-trip, and delete all worked against the real server. Both
  scratch containers were removed afterward. `embeddings.ts` itself
  (`GEMINI_API_KEY`) and the full `ingest-knowledge.ts` pipeline were
  **not** live-tested — no Gemini API key was available in this
  environment — so verify those against a real key before relying on them
  in a deployment.
