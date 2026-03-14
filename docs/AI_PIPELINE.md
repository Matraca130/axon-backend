# AI Pipeline Reference -- Axon v4.5

> **For agents:** This document explains the complete AI/RAG system.
> Read this BEFORE touching any file in `routes/ai/` or `gemini.ts`.
> **Updated:** 2026-03-14 (audit pass 6 — embedding migration reflected)

---

## Architecture Overview

```
+----------------------------------+     +------------------------------+
|         gemini.ts                |     |   openai-embeddings.ts       |
|  (Text generation ONLY)          |     |   (Embeddings ONLY)          |
|                                  |     |                              |
|  GENERATE_MODEL = gemini-2.5-flash|     |  EMBEDDING_MODEL =           |
|  generateText()     -> Gemini API |     |    text-embedding-3-large    |
|  extractTextFromPdf()-> Gemini    |     |  EMBEDDING_DIMENSIONS = 1536 |
|  parseGeminiJson()  -> JSON parse |     |  generateEmbedding() -> OpenAI|
|  fetchWithRetry()   -> retry      |     +------------------------------+
|                                  |               | imported by
|  generateEmbedding() = HARD ERROR|     +---------+---------+
|  (throws immediately, W7-RAG01)  |     | ingest.ts         |
+----------+-----------------------+     | chat.ts           |
           | imported by                  | auto-ingest.ts    |
    +------+------+------+               | ingest-pdf.ts     |
    |      |      |      |               +-------------------+
 generate chat  report pre-gen
```

## Model Configuration

### Text Generation Model
Edit ONE line in `gemini.ts`:
```ts
export const GENERATE_MODEL = "gemini-2.5-flash";
```

### Embedding Model (D57 Migration)

> **CRITICAL:** Embeddings use **OpenAI text-embedding-3-large** (1536d).
> The file is `openai-embeddings.ts` (NOT gemini.ts).
> `gemini.ts` `generateEmbedding()` **throws immediately** (W7-RAG01 safety).

Edit in `openai-embeddings.ts`:
```ts
export const EMBEDDING_MODEL = "text-embedding-3-large";
export const EMBEDDING_DIMENSIONS = 1536;
```

> **Dimension migration checklist** (if changing dimensions):
> 1. `EMBEDDING_DIMENSIONS` in `openai-embeddings.ts`
> 2. `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(NEW_DIM)`
> 3. `ALTER TABLE summaries ALTER COLUMN embedding TYPE vector(NEW_DIM)`
> 4. RPC signatures: `p_query_embedding vector(1536)`
> 5. Re-run ingest for ALL chunks and summaries
> 6. Recreate HNSW indexes (dimension-specific)

## Active Routes (11 mounted in index.ts)

| Route | File | Description |
|---|---|---|
| POST `/ai/generate` | generate.ts | Flashcard/quiz generation |
| POST `/ai/generate-smart` | generate-smart.ts | Adaptive NeedScore [8A] |
| POST `/ai/pre-generate` | pre-generate.ts | Bulk [8D] |
| POST `/ai/report` | report.ts | Quality report [8B] |
| GET `/ai/report-stats` | report-dashboard.ts | Metrics [8C] |
| GET `/ai/reports` | report-dashboard.ts | Listing [8C] |
| POST `/ai/ingest-embeddings` | ingest.ts | Batch embeddings |
| POST `/ai/ingest-pdf` | ingest-pdf.ts | PDF ingestion [Fase 7] |
| POST `/ai/re-chunk` | re-chunk.ts | Manual re-chunking |
| POST `/ai/rag-chat` | chat.ts | RAG chat |
| PATCH `/ai/rag-feedback` | feedback.ts | Thumbs |
| GET `/ai/rag-analytics` | analytics.ts | Metrics |
| GET `/ai/embedding-coverage` | analytics.ts | Coverage % |

**REMOVED (PHASE-A2):** `list-models.ts`, `re-embed-all.ts` — files on disk but NOT mounted.

## Rate Limiting

| Type | Limit | Scope |
|---|---|---|
| General | 120 req/min | Per user (in-memory) |
| AI POST | 20 req/hr | Per user (distributed RPC) |
| Pre-generate | 10 req/hr | Per user (own bucket) |
| Report POST | No AI limit | No Gemini cost |

## Security Model (PF-05)

```
1. authenticate(c)       -> Decode JWT locally
2. DB query              -> PostgREST validates JWT cryptographically
3. AI API call           -> Only AFTER step 2 succeeds
```

## PostgreSQL RPCs

| RPC | Purpose |
|---|---|
| `rag_hybrid_search` | Hybrid: pgvector cosine 70% + ts_rank FTS 30% |
| `resolve_parent_institution` | Walk hierarchy to institution |
| `get_student_knowledge_context` | Student adaptive profile |
| `check_rate_limit` | Distributed AI rate limit |
