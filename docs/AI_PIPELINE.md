# AI Pipeline Reference — Axon v4.4

> **For agents:** This document explains the complete AI/RAG system.
> Read this BEFORE touching any file in `routes/ai/` or `gemini.ts`.

---

## Architecture Overview

```
                    ┌─────────────────────────────────┐
                    │         gemini.ts                │
                    │  (Single source of truth)        │
                    │                                  │
                    │  GENERATE_MODEL = "gemini-2.5-flash"
                    │  generateText()     → Gemini API │
                    │  generateEmbedding()→ Gemini API │
                    │  parseGeminiJson()  → JSON parse │
                    │  getApiKey()        → Deno.env   │
                    │  fetchWithRetry()   → timeout +  │
                    │                       backoff    │
                    └──────────┬──────────────────────┘
                               │ imported by
            ┌──────────────────┼──────────────────────┐
            │                  │                      │
    ┌───────▼───────┐  ┌──────▼──────┐  ┌────────────▼────────┐
    │  generate.ts  │  │  ingest.ts  │  │     chat.ts         │
    │               │  │             │  │                     │
    │ POST /generate│  │ POST /ingest│  │ POST /rag-chat      │
    │               │  │ -embeddings │  │                     │
    │ Uses:         │  │             │  │ Uses:               │
    │ generateText  │  │ Uses:       │  │ generateEmbedding   │
    │ parseGemini.. │  │ generate..  │  │ + generateText      │
    │ GENERATE_MODEL│  │ Embedding   │  │ (embed query, then  │
    │               │  │             │  │  search, then gen)  │
    └───────────────┘  └─────────────┘  └─────────────────────┘
```

## Model Configuration

### Changing the generation model

Edit ONE line in `gemini.ts`:

```ts
export const GENERATE_MODEL = "gemini-2.5-flash"; // ← change here only
```

All endpoints import this constant. The `_meta.model` in responses will automatically reflect the change.

### Changing the embedding model

Edit inside `generateEmbedding()` in `gemini.ts`:

```ts
const model = "gemini-embedding-001"; // ← change model name
```

And if the new model has different dimensions, also change:

```ts
const EMBEDDING_DIMENSIONS = 768; // ← must match DB column: vector(768)
```

> **WARNING:** If you change dimensions, you must also:
> 1. Alter the DB column: `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(NEW_DIM)`
> 2. Re-run ingest for ALL chunks (old embeddings become incompatible)
> 3. Update the `rag_hybrid_search` RPC if it references dimension size

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
1. authenticate(c)       → Decode JWT locally
2. DB query (RPC/select) → PostgREST validates JWT cryptographically
3. Gemini API call       → Only AFTER step 2 succeeds
```

**Why this order matters:** `authenticate()` only base64-decodes the JWT. The cryptographic signature is validated by PostgREST when the first DB query executes. If we called Gemini before any DB query, a forged JWT could consume API credits.

## PostgreSQL RPCs

| RPC | Signature | Purpose |
|-----|-----------|---------|
| `resolve_parent_institution` | `(p_table text, p_id uuid) → uuid` | Walks hierarchy up to institution |
| `rag_hybrid_search` | `(p_query_embedding text, p_query_text text, p_institution_id uuid, p_summary_id uuid, p_match_count int, p_similarity_threshold float) → setof record` | Hybrid search: pgvector cosine + full-text |
| `get_student_knowledge_context` | `(p_student_id uuid, p_institution_id uuid) → jsonb` | Student adaptive profile |
| `get_course_summary_ids` | `(p_institution_id uuid) → setof record` | Fallback: all summary_ids for institution |

## Fix History

| Fix ID | Date | What changed |
|--------|------|-------------|
| D-16 | 2026-03-03 | Embedding model → `gemini-embedding-001` + `outputDimensionality: 768` |
| D-17 | 2026-03-03 | Generation model → `gemini-2.5-flash` (quota bucket separation) |
| D-18 | 2026-03-04 | `_meta.model` uses `GENERATE_MODEL` constant (was hardcoded) |
| PF-01 | Pre-flight | `memberships` table name fix (was `institution_members`) |
| PF-02 | Pre-flight | Ingest requires `institution_id` + role check |
| PF-05 | Pre-flight | DB queries before Gemini calls (JWT validation) |
| PF-09 | Pre-flight | Ingest uses admin client for embedding UPDATE |
| LA-01 | Live audit | Scoped fallback query in ingest |
| LA-02 | Live audit | AbortController timeout on fetch |
| LA-03 | Live audit | Message length validation + history truncation |
| LA-06 | Live audit | Retry with exponential backoff |
| LA-07 | Live audit | `truncateAtWord()` respects word boundaries |
| BUG-1 | Pre-flight | `created_by: user.id` in inserts |
| BUG-3 | Pre-flight | Institution scoping via `resolve_parent_institution` |
| BUG-4 | Pre-flight | `keyword_id` fallback from summary's first keyword |
