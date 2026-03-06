# Axon Backend Map

> Single source of truth for navigating the `axon-backend` repository.
> Last updated: 2026-03-08 (Fase 8 Par 4 cleanup — 40 migration files, 12 AI files, 6 test files)

## Repository Structure

```
axon-backend/
|-- .github/workflows/deploy.yml       <- GitHub Actions: deploy to Supabase on push to main
|-- docs/
|   |-- AGENT_INDEX.md                  <- Quick lookup for agents (start here)
|   |-- AGENT_RULES.md                  <- Critical rules for AI agents
|   |-- AI_PIPELINE.md                  <- AI/RAG architecture, models, security, payloads
|   |-- BACKEND_AUDIT.md                <- Historical audit (Feb 2026, updated Mar 2026)
|   |-- BACKEND_MAP.md                  <- THIS FILE
|   |-- RAG_ROADMAP.md                  <- RAG implementation plan (8 phases)
|   +-- figma-make/                     <- Figma Make context docs (7 files)
|       |-- 00-contexto-base.md
|       |-- 01-area-profesor.md
|       |-- 02-area-alumno.md
|       |-- 03-area-admin.md
|       |-- 04-foco-resumenes.md
|       |-- 05-foco-estudio.md
|       |-- 06-ai-rag.md                <- AI/RAG endpoints, payloads, pipeline
|       +-- README.md
|-- supabase/
|   |-- migrations/                     <- All SQL migrations (40 files)
|   +-- functions/server/               <- Edge Function (Hono + Deno)
|       |-- index.ts                    <- ENTRYPOINT: mounts all routes + middleware
|       |-- db.ts                       <- Supabase clients, auth, response helpers
|       |-- crud-factory.ts             <- Generic CRUD route generator
|       |-- validate.ts                 <- Type guards + declarative field validator
|       |-- auth-helpers.ts             <- Role-based access control (requireInstitutionRole)
|       |-- rate-limit.ts               <- In-memory sliding window rate limiter
|       |-- timing-safe.ts              <- Constant-time string comparison
|       |-- gemini.ts                   <- Gemini API helpers + GENERATE_MODEL constant
|       |-- chunker.ts                  <- Recursive Character chunking engine (Fase 5)
|       |-- auto-ingest.ts              <- Auto-chunking + embedding pipeline (Fase 5 + Fase 3)
|       |-- summary-hook.ts             <- afterWrite hook for summaries (Fase 5)
|       |
|       |-- routes/                     <- SPLIT MODULES (7 domains)
|       |   |-- content/                <- Content hierarchy (8 files)
|       |   |   |-- index.ts            <- Module combiner
|       |   |   |-- crud.ts             <- 9 registerCrud (courses->subtopics)
|       |   |   |-- keyword-connections.ts  <- Manual CRUD
|       |   |   |-- keyword-search.ts   <- Institution-scoped keyword search
|       |   |   |-- prof-notes.ts       <- kw_prof_notes upsert
|       |   |   |-- reorder.ts          <- Bulk reorder (M-3 RPC + fallback)
|       |   |   |-- content-tree.ts     <- Nested hierarchy GET
|       |   |   +-- flashcards-by-topic.ts <- Batch flashcard load by topic (PERF C1)
|       |   |-- study/                  <- Study system (6 files)
|       |   |   |-- index.ts            <- Module combiner
|       |   |   |-- sessions.ts         <- 3 registerCrud (sessions, plans, tasks)
|       |   |   |-- reviews.ts          <- Reviews + quiz-attempts (O-3 ownership)
|       |   |   |-- progress.ts         <- topic-progress, topics-overview, reading-states, daily-activities, student-stats
|       |   |   |-- spaced-rep.ts       <- FSRS + BKT states
|       |   |   +-- batch-review.ts     <- POST /review-batch (PERF M1: atomic batch)
|       |   |-- ai/                     <- AI / RAG module (12 files)
|       |   |   |-- index.ts            <- AI module combiner + rate limit middleware
|       |   |   |-- generate.ts         <- POST /ai/generate (manual: client provides IDs)
|       |   |   |-- generate-smart.ts   <- POST /ai/generate-smart (adaptive: NeedScore auto-target) [Fase 8A]
|       |   |   |-- pre-generate.ts     <- POST /ai/pre-generate (bulk: professor fills gaps) [Fase 8D]
|       |   |   |-- report.ts           <- POST /ai/report + PATCH /ai/report/:id [Fase 8B]
|       |   |   |-- report-dashboard.ts <- GET /ai/report-stats + GET /ai/reports [Fase 8C]
|       |   |   |-- ingest.ts           <- POST /ai/ingest-embeddings (batch embeddings + summary embed)
|       |   |   |-- re-chunk.ts         <- POST /ai/re-chunk (manual re-chunking) [Fase 5]
|       |   |   |-- chat.ts             <- POST /ai/rag-chat (coarse-to-fine + hybrid search + Gemini)
|       |   |   |-- feedback.ts         <- PATCH /ai/rag-feedback (T-03)
|       |   |   |-- analytics.ts        <- GET /ai/rag-analytics + /ai/embedding-coverage (T-03)
|       |   |   +-- list-models.ts      <- GET /ai/list-models (diagnostic)
|       |   |-- members/                <- Institutions + memberships (4 files)
|       |   |   |-- index.ts
|       |   |   |-- institutions.ts
|       |   |   |-- memberships.ts
|       |   |   +-- admin-scopes.ts
|       |   |-- mux/                    <- Mux video integration (5 files)
|       |   |   |-- index.ts
|       |   |   |-- api.ts              <- create-upload, playback-token, asset
|       |   |   |-- helpers.ts          <- Mux client, JWT signing
|       |   |   |-- tracking.ts         <- track-view, video-stats
|       |   |   +-- webhook.ts          <- /webhooks/mux
|       |   |-- plans/                  <- Plans + AI + access control (5 files)
|       |   |   |-- index.ts
|       |   |   |-- crud.ts             <- 4 registerCrud
|       |   |   |-- ai-generations.ts   <- AI generation tracking + usage-today
|       |   |   |-- diagnostics.ts      <- Summary diagnostics
|       |   |   +-- access.ts           <- /content-access check
|       |   |-- search/                 <- Global search + trash (4 files)
|       |   |   |-- index.ts
|       |   |   |-- search.ts
|       |   |   |-- trash-restore.ts
|       |   |   +-- helpers.ts
|       |   +-- settings/               <- Institution settings
|       |       +-- index.ts
|       |
|       |-- routes-auth.tsx             <- Auth & profiles (6KB)
|       |-- routes-billing.tsx          <- Stripe integration (15KB)
|       |-- routes-models.tsx           <- 3D models, pins, notes (2KB)
|       |-- routes-storage.tsx          <- File upload/download/delete (9KB)
|       |-- routes-student.tsx          <- Student instruments & notes (6KB)
|       |-- routes-study-queue.tsx       <- Study queue algorithm (15KB)
|       |
|       +-- tests/                      <- Deno-native tests (6 files)
|           |-- auth_helpers_test.ts
|           |-- fase3_test.ts           <- 8 tests: truncateAtWord + summary_embedded assertion
|           |-- rate_limit_test.ts
|           |-- validate_test.ts
|           |-- timing_safe_test.ts
|           +-- summary_hook_test.ts    <- 9 tests for afterWrite gate logic (Fase 5)
+-- README.md
```

---

## How index.ts Imports Everything

```ts
// Split modules (direct import from routes/)
import { content }       from "./routes/content/index.ts";
import { studyRoutes }   from "./routes/study/index.ts";
import { memberRoutes }  from "./routes/members/index.ts";
import { muxRoutes }     from "./routes/mux/index.ts";
import { planRoutes }    from "./routes/plans/index.ts";
import { searchRoutes }  from "./routes/search/index.ts";
import { settingsRoutes } from "./routes/settings/index.ts";
import { aiRoutes }      from "./routes/ai/index.ts";

// Flat route files (small enough or single-purpose)
import { authRoutes }        from "./routes-auth.tsx";
import { billingRoutes }     from "./routes-billing.tsx";
import { modelRoutes }       from "./routes-models.tsx";
import { storageRoutes }     from "./routes-storage.tsx";
import { studentRoutes }     from "./routes-student.tsx";
import { studyQueueRoutes }  from "./routes-study-queue.tsx";
```

---

## Infrastructure Files

### `db.ts` — Core Auth & Database

| Export | Description |
|---|---|
| `PREFIX` | Route prefix (`"/server"` in production) |
| `getAdminClient()` | SERVICE_ROLE Supabase client (bypasses RLS). Lazy singleton |
| `getUserClient(jwt)` | Per-request client that respects RLS via user JWT |
| `extractToken(c)` | Gets JWT from `X-Access-Token` (Figma Make) or `Authorization` header |
| `authenticate(c)` | Decodes JWT locally (~0.1ms), returns `{ user, db }` or error Response |
| `safeJson(c)` | Safe JSON body parser (returns null instead of throwing) |
| `ok(c, data, status)` | Standard success response `{ data }` |
| `err(c, message, status)` | Standard error response `{ error }` with logging |

### `crud-factory.ts` — Generic CRUD Generator

`registerCrud(app, config)` generates 5 endpoints per table (LIST, GET, CREATE, UPDATE, DELETE).

### `validate.ts` — Runtime Validation

**Type guards:** `isStr`, `isNonEmpty`, `isNum`, `isBool`, `isObj`
**Format validators:** `isUuid`, `isEmail`, `isIsoTs`, `isDateOnly`
**Numeric ranges:** `inRange(v, min, max)`, `isNonNeg`, `isNonNegInt`, `isProbability`
**Enum validator:** `isOneOf(v, values)`
**Declarative batch:** `validateFields(body, rules)`

### `auth-helpers.ts` — Role-Based Access Control

| Export | Description |
|---|---|
| `requireInstitutionRole(db, userId, instId, allowedRoles)` | Verifies user has one of the allowed roles in the institution |
| `isDenied(result)` | Type guard: returns true if role check failed |
| `ALL_ROLES` | All roles: owner, admin, professor, student |
| `CONTENT_WRITE_ROLES` | Roles that can write content: owner, admin, professor |

### `gemini.ts` — Gemini API Helpers

| Export | Description |
|---|---|
| `GENERATE_MODEL` | Current generation model name (`"gemini-2.5-flash"`). Single source of truth |
| `generateText(opts)` | Call Gemini for text/JSON generation. Includes timeout + retry |
| `generateEmbedding(text, taskType)` | Generate 768-dim embedding vector. Includes timeout + retry |
| `parseGeminiJson(text)` | Safely parse JSON from Gemini output (strips markdown fences) |
| `getApiKey()` | Get GEMINI_API_KEY from Deno.env (throws if missing) |

### `rate-limit.ts` — 120 req/min sliding window
### `timing-safe.ts` — Constant-time comparison for webhook signatures

---

## Route Modules — Complete Endpoint Reference

### `routes/content/` — Content Hierarchy (8 files)

**Factory CRUD (9 tables):** `courses`, `semesters`, `sections`, `topics`, `summaries`, `chunks`, `summary-blocks`, `keywords`, `subtopics`

**Manual endpoints:**

| Method | Path | File | Description |
|---|---|---|---|
| GET | `/keyword-connections?keyword_id=` | keyword-connections.ts | List connections (either side) |
| GET | `/keyword-connections/:id` | keyword-connections.ts | Get by ID |
| POST | `/keyword-connections` | keyword-connections.ts | Create (enforces a < b) |
| DELETE | `/keyword-connections/:id` | keyword-connections.ts | Hard delete |
| GET | `/kw-prof-notes?keyword_id=` | prof-notes.ts | List professor notes |
| GET | `/kw-prof-notes/:id` | prof-notes.ts | Get by ID |
| POST | `/kw-prof-notes` | prof-notes.ts | Upsert (one per prof per keyword) |
| DELETE | `/kw-prof-notes/:id` | prof-notes.ts | Hard delete |
| PUT | `/reorder` | reorder.ts | Bulk reorder (M-3: RPC + fallback) |
| GET | `/content-tree?institution_id=` | content-tree.ts | Nested hierarchy tree |
| GET | `/flashcards-by-topic?topic_id=` | flashcards-by-topic.ts | Batch load all flashcards for a topic (PERF C1) |

### `routes/study/` — Study System (6 files)

**Factory CRUD (3 tables):** `study-sessions`, `study-plans`, `study-plan-tasks`

**Unified endpoints (N+1 eliminators):**

| Method | Path | File | Description |
|---|---|---|---|
| GET | `/topic-progress?topic_id=` | progress.ts | Summaries + reading states + flashcard counts in 1 request (was 1+2N) |
| GET | `/topics-overview?topic_ids=a,b,c` | progress.ts | Summaries by topic + keyword counts (batch, max 50) |

**Manual endpoints:**

| Method | Path | File | Description |
|---|---|---|---|
| GET | `/reviews?session_id=` | reviews.ts | List reviews (O-3: session ownership) |
| POST | `/reviews` | reviews.ts | Create review (grade 0-5) |
| GET | `/quiz-attempts?quiz_question_id=&session_id=` | reviews.ts | List attempts |
| POST | `/quiz-attempts` | reviews.ts | Create attempt |
| POST | `/review-batch` | batch-review.ts | Atomic batch: reviews + FSRS + BKT in 1 request (PERF M1) |
| GET | `/reading-states?summary_id=` | progress.ts | Get reading state |
| POST | `/reading-states` | progress.ts | Upsert reading state |
| GET | `/daily-activities?from=&to=` | progress.ts | List (P-2: capped 500) |
| POST | `/daily-activities` | progress.ts | Upsert |
| GET | `/student-stats` | progress.ts | Get student stats |
| POST | `/student-stats` | progress.ts | Upsert |
| GET | `/fsrs-states?flashcard_id=&state=&due_before=` | spaced-rep.ts | List (capped 500) |
| POST | `/fsrs-states` | spaced-rep.ts | Upsert |
| GET | `/bkt-states?subtopic_id=` | spaced-rep.ts | List (capped 500) |
| POST | `/bkt-states` | spaced-rep.ts | Upsert |

### `routes/ai/` — AI / RAG Module (12 files)

**Rate limit middleware** (in `index.ts`):
- 20 POST requests/hour per user via distributed `check_rate_limit()` RPC
- Excludes: all GET/PATCH, POST `/ai/report` (no Gemini), POST `/ai/pre-generate` (own bucket)

| Method | Path | File | Auth | Description |
|---|---|---|---|---|
| POST | `/ai/generate` | generate.ts | ALL_ROLES | Generate flashcard/quiz (client provides summary_id + keyword_id) |
| POST | `/ai/generate-smart` | generate-smart.ts | ALL_ROLES | Adaptive generation (NeedScore auto-selects best keyword) [Fase 8A] |
| POST | `/ai/pre-generate` | pre-generate.ts | CONTENT_WRITE | Bulk pre-generation (professor fills coverage gaps, own rate limit) [Fase 8D] |
| POST | `/ai/report` | report.ts | ALL_ROLES | Report AI content quality issue (student flags bad content) [Fase 8B] |
| PATCH | `/ai/report/:id` | report.ts | CONTENT_WRITE | Resolve/dismiss a quality report [Fase 8B] |
| GET | `/ai/report-stats` | report-dashboard.ts | CONTENT_WRITE | Aggregate quality metrics via RPC [Fase 8C] |
| GET | `/ai/reports` | report-dashboard.ts | CONTENT_WRITE | Paginated report listing with filters [Fase 8C] |
| POST | `/ai/ingest-embeddings` | ingest.ts | MANAGEMENT | Batch-generate embeddings for chunks + summaries [Fase 3] |
| POST | `/ai/re-chunk` | re-chunk.ts | CONTENT_WRITE | Manual re-chunking of a summary [Fase 5] |
| POST | `/ai/rag-chat` | chat.ts | ALL_ROLES | Coarse-to-fine + hybrid search + Gemini response [Fase 3] |
| PATCH | `/ai/rag-feedback` | feedback.ts | ALL_ROLES | Submit feedback on RAG chat response (thumbs up/down) [T-03] |
| GET | `/ai/rag-analytics` | analytics.ts | MANAGEMENT | RAG query metrics (aggregated) [T-03] |
| GET | `/ai/embedding-coverage` | analytics.ts | MANAGEMENT | % of chunks with embeddings [T-03] |
| GET | `/ai/list-models` | list-models.ts | ALL_ROLES | Diagnostic: list available Gemini models |

> Full documentation: [`docs/AI_PIPELINE.md`](AI_PIPELINE.md) and [`docs/figma-make/06-ai-rag.md`](figma-make/06-ai-rag.md)

### `routes/members/` — Institutions & Memberships (4 files)

| File | Endpoints |
|---|---|
| institutions.ts | CRUD for institutions + join-by-code |
| memberships.ts | CRUD for institution memberships |
| admin-scopes.ts | Admin scope management |

### `routes/mux/` — Mux Video Integration (5 files)

| File | Endpoints |
|---|---|
| api.ts | `/mux/create-upload`, `/mux/playback-token`, `/mux/asset/:video_id` |
| tracking.ts | `/mux/track-view`, `/mux/video-stats` |
| webhook.ts | `/webhooks/mux` (O-7: idempotent) |
| helpers.ts | Mux client, JWT signing utilities |

### `routes/plans/` — Plans & AI (5 files)

| File | Endpoints |
|---|---|
| crud.ts | CRUD for `platform-plans`, `institution-plans`, `plan-access-rules`, `institution-subscriptions` |
| ai-generations.ts | `/ai-generations`, `/usage-today` (P-8: proper boundary) |
| diagnostics.ts | `/summary-diagnostics` |
| access.ts | `/content-access` |

### `routes/search/` — Global Search & Trash (4 files)

| File | Endpoints |
|---|---|
| search.ts | `GET /search` (N-1: parallel queries, N-8: escapeLike) |
| trash-restore.ts | `GET /trash`, `POST /restore/:table/:id` |
| helpers.ts | `escapeLike()`, path resolution (P-1, P-3) |

### Flat Route Files (not split)

| File | Size | Endpoints |
|---|---|---|
| `routes-auth.tsx` | 6KB | `/signup`, `/me` (GET/PUT) |
| `routes-billing.tsx` | 15KB | `/billing/*`, `/webhooks/stripe` (N-10: timing-safe) |
| `routes-models.tsx` | 2KB | CRUD for `models-3d`, `model-3d-pins`, `model-3d-notes` |
| `routes-storage.tsx` | 9KB | `/storage/upload`, `/storage/signed-url`, `/storage/delete` |
| `routes-student.tsx` | 6KB | CRUD for `flashcards`, `quiz-questions`, `student-notes`, `student-annotations`, `videos`, `highlight-tags` |
| `routes-study-queue.tsx` | 15KB | `GET /study-queue` (custom algorithm) |

---

## Migrations Inventory

### `supabase/migrations/` (40 files — single canonical directory)

| File | Code | Status | Description |
|---|---|---|---|
| `20260224_01` | EV-9 | Applied | Mux columns on videos table |
| `20260224_02` | EV-9 | Applied | video_views table + indexes |
| `20260227_01` | M-3 | Applied | bulk_reorder() DB function |
| `20260227_02` | -- | Applied | get_course_summary_ids() helper (p_course_id overload) |
| `20260227_03` | N-7 | Applied | upsert_video_view() atomic function |
| `20260227_04` | N-5 | PENDING | get_content_tree() RPC |
| `20260227_05` | O-4 | PENDING | Trigram indexes for ILIKE search |
| `20260227_06` | O-7 | PENDING | processed_webhook_events table |
| `20260228_01` | -- | Applied | Dashboard aggregation triggers + backfill |
| `20260228_02` | -- | Applied | summary_blocks table |
| `20260228_03` | -- | Applied | keyword_connections.relationship column |
| `20260302_01` | -- | PENDING | Composite/partial indexes for high-read tables |
| `20260303_01` | -- | Applied | summaries.estimated_study_minutes column |
| `20260303_02` | -- | Applied | Distributed rate limiting (UNLOGGED table + check_rate_limit RPC) |
| `20260303_03` | S-3 | Applied | get_study_queue() RPC (SQL-based NeedScore) |
| `20260304_01a` | -- | Applied | algorithm_config table (NeedScore weights) |
| `20260304_01b` | S-3 | Applied | get_study_queue() v2 with institution scoping |
| `20260304_02` | -- | Applied | Scoped search + trash RPCs (institution_id filter) |
| `20260304_03` | -- | Applied | resolve_parent_institution() RPC v1 |
| `20260304_04` | -- | Applied | resolve_parent_institution() RPC v2 (expanded table support) |
| `20260304_05` | INC-5 | Applied | get_institution_summary_ids() RPC (p_institution_id overload) |
| `20260304_06` | INC-7 | Applied | Denormalize institution_id on summaries (Fase 1 RAG Roadmap) |
| `20260305_01` | -- | Applied | mv_knowledge_profile materialized view |
| `20260305_02` | -- | Applied | get_student_knowledge_context() RPC |
| `20260305_03` | LA-04 | Applied | pgvector setup: chunks.embedding + HNSW index + rag_hybrid_search() |
| `20260305_04a` | -- | Applied | pg_cron job: refresh mv_knowledge_profile every 15 min |
| `20260305_04b` | T-03 | Applied | rag_query_log table + indexes + RLS + analytics RPCs |
| `20260305_05` | -- | Applied | idx_chunks_summary_order index |
| `20260305_06` | -- | Applied | search_keywords_by_institution RPC |
| `20260306_01` | -- | Applied | keyword_connections v2 (type column) |
| `20260306_02a` | -- | Applied | fts_columns_and_rpc_v3 (tsvector + GIN + RPC) |
| `20260306_02b` | -- | Applied | restore_optimized_rag_hybrid_search |
| `20260306_02c` | -- | Applied | search_kw_published_filter |
| `20260306_03` | T-02 | Applied | tsvector GIN columns (Fase 2) |
| `20260307_01` | -- | Applied | Consolidated RAG safe-apply (tsvector + GIN + RPC v3) |
| `20260307_02` | F5 | Applied | Chunking columns: chunk_strategy + last_chunked_at (Fase 5) |
| `20260307_03` | F3 | Applied | Summary embeddings + HNSW + rag_coarse_to_fine_search() (Fase 3) |
| `20260308_01` | F8A | PENDING | get_smart_generate_target() RPC — NeedScore keyword selection (Fase 8A) |
| `20260308_02` | F8B | PENDING | ai_content_reports table + indexes + RLS (Fase 8B) |
| `20260308_03` | F8C | PENDING | get_ai_report_stats() RPC — aggregate quality metrics (Fase 8C) |

> **Note on duplicate date prefixes:** Some dates have multiple files (e.g. `20260304_01`,
> `20260305_04`, `20260306_02`). Listed here with letter suffixes (a/b/c) for clarity.
> All are applied unless marked PENDING.

> **Note on Fase 8 migrations:** `20260308_01/02/03` must be applied via SQL Editor after merge.

---

## Security Fixes Log

### N-series (Network/Performance)
| Code | Fix | File |
|---|---|---|
| N-1 | Search queries run in parallel | routes/search/search.ts |
| N-2 | Trash queries run in parallel | routes/search/trash-restore.ts |
| N-5 | Content tree DB function (RPC with graceful fallback) | routes/content/content-tree.ts |
| N-6 | Auto-profile fetches metadata via admin.auth | routes-auth.tsx |
| N-7 | Atomic upsert_video_view (no race condition) | routes/mux/tracking.ts |
| N-8 | escapeLike() sanitizes SQL wildcards | routes/search/helpers.ts |
| N-10 | Timing-safe Stripe signature verification | routes-billing.tsx |
| NEW | topic-progress unified endpoint (N+1->1) | routes/study/progress.ts |
| NEW | topics-overview batch endpoint (N+1->1) | routes/study/progress.ts |

### O-series (Security/Safety)
| Code | Fix | File |
|---|---|---|
| O-1 | or() filter values quoted (injection-safe) | routes/search/search.ts |
| O-2 | signed-url and delete use safeJson() | routes-storage.tsx |
| O-3 | Session ownership verification for reviews | routes/study/reviews.ts |
| O-4 | Trigram indexes for search performance | migration 20260227_05 |
| O-6 | base64 upload wraps atob() in try/catch | routes-storage.tsx |
| O-7 | Webhook idempotency via event tracking | routes-billing.tsx, routes/mux/webhook.ts |
| O-8 | Rate limiting middleware (120 req/min) | rate-limit.ts, index.ts |

### P-series (Polish/Validation)
| Code | Fix | File |
|---|---|---|
| P-1 | Full Course>Semester>Topic>Summary path resolution | routes/search/helpers.ts |
| P-2 | Pagination capped at 500 items | routes/plans/*, routes/study/progress.ts |
| P-3 | Double quotes escaped in PostgREST or() | routes/search/helpers.ts |
| P-4 | Upload JSON path uses safeJson() | routes-storage.tsx |
| P-5 | Password max length capped at 128 | routes-auth.tsx |
| P-6 | Auto-profile uses upsert (race condition) | routes-auth.tsx |
| P-7 | Signed URL batch capped at 100 paths | routes-storage.tsx |
| P-8 | usage-today uses proper tomorrow boundary | routes/plans/ai-generations.ts |

### AI-series (AI/RAG fixes)
| Code | Fix | File |
|---|---|---|
| PF-01 | `memberships` table name fix (was `institution_members`) | routes/ai/chat.ts |
| PF-02 | Ingest requires `institution_id` + role check | routes/ai/ingest.ts |
| PF-05 | DB queries before Gemini calls (JWT validation security) | routes/ai/*.ts |
| PF-09 | Ingest uses admin client for embedding UPDATE (bypass RLS) | routes/ai/ingest.ts |
| BUG-1 | `created_by: user.id` in AI-generated inserts | routes/ai/generate.ts, generate-smart.ts, pre-generate.ts |
| BUG-3 | Institution scoping via `resolve_parent_institution` | routes/ai/generate.ts, generate-smart.ts, pre-generate.ts |
| BUG-4 | `keyword_id` fallback from summary's first keyword | routes/ai/generate.ts |
| LA-01 | Scoped fallback query in ingest (cross-tenant prevention) | routes/ai/ingest.ts |
| LA-02 | AbortController timeout on Gemini fetch (15s/10s) | gemini.ts |
| LA-03 | Message length validation (2000 chars) + history truncation (6 entries) | routes/ai/chat.ts |
| LA-06 | Retry with exponential backoff for 429/503 | gemini.ts |
| LA-07 | `truncateAtWord()` respects word boundaries | routes/ai/generate.ts |
| D-16 | Embedding model -> `gemini-embedding-001` + `outputDimensionality: 768` | gemini.ts |
| D-17 | Generation model -> `gemini-2.5-flash` (quota bucket separation) | gemini.ts |
| D-18 | `_meta.model` uses `GENERATE_MODEL` constant (was hardcoded) | routes/ai/generate.ts |
| D-9 | Pre-generate has separate rate limit bucket (`ai-pregen:{userId}`, 10/hr) | routes/ai/pre-generate.ts |

### PERF-series (Performance batch endpoints)
| Code | Fix | File |
|---|---|---|
| C1 | Batch flashcard load by topic (eliminates N+1) | routes/content/flashcards-by-topic.ts |
| M1 | Atomic batch review persistence (90 reqs -> 1) | routes/study/batch-review.ts |

### INC-series (Cross-audit fixes — 2026-03-04)
| Code | Fix | File |
|---|---|---|
| INC-5 | `get_institution_summary_ids()` RPC for institution-scoped ingest | migration 20260304_05 |
| INC-7 | Denormalize `institution_id` on summaries + sync trigger (Fase 1) | migration 20260304_06 |

### F8-series (Fase 8 — IA Adaptativa — 2026-03-08)
| Code | Fix | File |
|---|---|---|
| F8A | NeedScore-based adaptive generation (generate-smart) | routes/ai/generate-smart.ts, migration 20260308_01 |
| F8B | AI content quality reporting (report + resolve) | routes/ai/report.ts, migration 20260308_02 |
| F8C | Quality dashboard (stats RPC + paginated listing) | routes/ai/report-dashboard.ts, migration 20260308_03 |
| F8D | Bulk content pre-generation (separate rate limit) | routes/ai/pre-generate.ts |

---

## Environment Variables

| Variable | Required | Used by |
|---|---|---|
| `SUPABASE_URL` | Yes | db.ts |
| `SUPABASE_ANON_KEY` | Yes | db.ts |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | db.ts |
| `GEMINI_API_KEY` | For AI | gemini.ts |
| `STRIPE_SECRET_KEY` | For billing | routes-billing.tsx |
| `STRIPE_WEBHOOK_SECRET` | For billing | routes-billing.tsx |
| `MUX_TOKEN_ID` | For video | routes/mux/helpers.ts |
| `MUX_TOKEN_SECRET` | For video | routes/mux/helpers.ts |
| `MUX_WEBHOOK_SECRET` | For video | routes/mux/webhook.ts |
| `MUX_SIGNING_KEY_ID` | For video | routes/mux/helpers.ts |
| `MUX_SIGNING_KEY_SECRET` | For video | routes/mux/helpers.ts |

---

## Tests

### `tests/` (Deno-native — 6 files)

| File | Covers |
|---|---|
| `auth_helpers_test.ts` | requireInstitutionRole, isDenied, role checks |
| `fase3_test.ts` | 8 tests: truncateAtWord + AutoIngestResult.summary_embedded (Fase 3) |
| `rate_limit_test.ts` | Sliding window rate limiter |
| `validate_test.ts` | All type guards + validateFields |
| `timing_safe_test.ts` | Constant-time comparison |
| `summary_hook_test.ts` | 9 tests for afterWrite gate logic (Fase 5) |

Run: `deno test supabase/functions/server/tests/`

---

## Pending Work

### Route Splitting
- `routes-billing.tsx` (15KB) — Could split into `routes/billing/` (checkout, portal, subscription, webhook)
- `routes-study-queue.tsx` (15KB) — Single complex algorithm, split may not help

### File Extensions
- Some flat route files use `.tsx` despite not using JSX (historical artifact)
- Low priority: rename to `.ts` when convenient

### RAG Roadmap Pending (see `docs/RAG_ROADMAP.md`)
- Fase 6: Advanced retrieval (Multi-Query + HyDE + Re-ranking)
- Fase 7: Multi-source ingestion (PDF)
