# AI Pipeline Reference -- Axon v4.4

> **For agents:** This document explains the complete AI/RAG system as it exists today.
> Read this BEFORE touching any file in `routes/ai/` or `gemini.ts`.
> For pending features and implementation plan, see [RAG_ROADMAP.md](./RAG_ROADMAP.md).

---

## Architecture Overview

```
                    +----------------------------------+
                    |         gemini.ts                |
                    |  (Single source of truth)        |
                    |                                  |
                    |  GENERATE_MODEL = "gemini-2.5-flash"
                    |  generateText()     -> Gemini API |
                    |  generateEmbedding()-> Gemini API |
                    |  parseGeminiJson()  -> JSON parse |
                    |  getApiKey()        -> Deno.env   |
                    |  fetchWithRetry()   -> timeout +  |
                    |                       backoff    |
                    +----------+-----------------------+
                               | imported by
            +------------------+----------------------+
            |                  |                      |
    +-------v-------+  +------v------+  +------------v--------+
    |  generate.ts  |  |  ingest.ts  |  |     chat.ts         |
    |               |  |             |  |                     |
    | POST /generate|  | POST /ingest|  | POST /rag-chat      |
    |               |  | -embeddings |  |                     |
    | Uses:         |  |             |  | Uses:               |
    | generateText  |  | Uses:       |  | generateEmbedding   |
    | parseGemini.. |  | generate..  |  | + generateText      |
    | GENERATE_MODEL|  | Embedding   |  | (embed query, then  |
    |               |  |             |  |  search, then gen)  |
    +---------------+  +-------------+  +---------------------+
```

## Model Configuration

### Changing the generation model

Edit ONE line in `gemini.ts`:

```ts
export const GENERATE_MODEL = "gemini-2.5-flash"; // <- change here only
```

All endpoints import this constant. The `_meta.model` in responses will automatically reflect the change.

### Changing the embedding model

Edit inside `generateEmbedding()` in `gemini.ts`:

```ts
const model = "gemini-embedding-001"; // <- change model name
```

And if the new model has different dimensions, also change:

```ts
const EMBEDDING_DIMENSIONS = 768; // <- must match DB column: vector(768)
```

> **WARNING — Full dimension migration checklist:**
>
> If you change embedding dimensions, you must update ALL of these:
> 1. `EMBEDDING_DIMENSIONS` in `gemini.ts`
> 2. `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(NEW_DIM)`
> 3. `ALTER TABLE summaries ALTER COLUMN embedding TYPE vector(NEW_DIM)` (if Fase 3 from RAG_ROADMAP implemented)
> 4. Function signature: `p_query_embedding vector(768)` in `rag_hybrid_search()`
> 5. Function signature: `p_query_embedding vector(768)` in `rag_coarse_to_fine_search()` (if exists)
> 6. Re-run ingest for ALL chunks and summaries (old embeddings are incompatible)
> 7. Recreate HNSW indexes (they are dimension-specific)

## Retry & Rate Limiting

`fetchWithRetry()` in `gemini.ts` handles:

| Behavior | Config |
|----------|--------|
| Timeout (generate) | 15 seconds |
| Timeout (embed) | 10 seconds |
| Retry on 429/503 | Up to 3 retries |
| Backoff | Exponential: 1s, 2s, 4s (max 8s) |
| Ingest throttle | 1s pause every 10 embeddings |

## Security Model

All AI routes follow this pattern (PF-05):

```
1. authenticate(c)       -> Decode JWT locally
2. DB query (RPC/select) -> PostgREST validates JWT cryptographically
3. Gemini API call       -> Only AFTER step 2 succeeds
```

**Why this order matters:** `authenticate()` only base64-decodes the JWT. The cryptographic signature is validated by PostgREST when the first DB query executes. If we called Gemini before any DB query, a forged JWT could consume API credits.

## PostgreSQL RPCs

| RPC | Signature | Purpose |
|-----|-----------|---------|
| `resolve_parent_institution` | `(p_table text, p_id uuid) -> uuid` | Walks hierarchy up to institution |
| `rag_hybrid_search` | `(p_query_embedding text, p_query_text text, p_institution_id uuid, p_summary_id uuid, p_match_count int, p_similarity_threshold float) -> setof record` | Hybrid search: pgvector cosine 70% + ts_rank FTS 30% |
| `get_student_knowledge_context` | `(p_student_id uuid, p_institution_id uuid) -> jsonb` | Student adaptive profile |
| `get_course_summary_ids` | `(p_institution_id uuid) -> setof record` | Fallback: all summary_ids for institution |

## Fix History

The complete fix log for all AI/RAG changes is maintained in [BACKEND_MAP.md > AI-series fixes](./BACKEND_MAP.md#ai-series-airag-fixes).

Key fixes to be aware of:

| Fix | Impact | What to remember |
|-----|--------|------------------|
| **D-18** | `_meta.model` | Always use `GENERATE_MODEL` constant, never hardcode model names |
| **PF-05** | Security | DB query BEFORE Gemini call (validates JWT) |
| **PF-09** | Ingest | Uses `getAdminClient()` to bypass RLS for embedding UPDATEs |
| **LA-03** | Validation | `message` max 2000 chars, `history` max 6 entries |
| **D-16** | Embeddings | `outputDimensionality: 768` truncates from 3072 |
| **LA-04** | Index | HNSW (not IVFFlat) for vector index -- works with 0 rows |
| **LA-05** | RPC | CTE computes cosine distance once per row (was 3x) |
