# Axon Backend Map

> Single source of truth for navigating the `axon-backend` repository.
> Last updated: 2026-03-03

## Repository Structure

```
axon-backend/
├── .github/workflows/deploy.yml       ← GitHub Actions: deploy to Supabase on push to main
├── docs/
│   ├── AGENT_INDEX.md                  ← Quick lookup for agents (start here)
│   ├── AGENT_RULES.md                  ← Critical rules for AI agents
│   ├── BACKEND_AUDIT.md                ← Historical audit (Feb 2026)
│   ├── BACKEND_MAP.md                  ← THIS FILE
│   └── figma-make/                     ← Figma Make context docs
├── migrations/                         ← ⚠️ ROOT migrations (DUPLICATE — needs cleanup)
│   ├── 20260227_03_upsert_video_view.sql         (duplicate of supabase/migrations/)
│   ├── 20260227_04_content_tree_rpc.sql          (⚠️ ONLY HERE — not in supabase/migrations/)
│   ├── 20260227_05_trigram_indexes.sql            (⚠️ ONLY HERE — not in supabase/migrations/)
│   └── 20260227_06_webhook_events_table.sql       (⚠️ ONLY HERE — not in supabase/migrations/)
├── supabase/
│   ├── migrations/                     ← Primary migrations (9 files)
│   │   ├── 20260224_01_videos_mux_columns.sql
│   │   ├── 20260224_02_video_views.sql
│   │   ├── 20260227_01_bulk_reorder.sql
│   │   ├── 20260227_02_get_course_summary_ids.sql
│   │   ├── 20260227_03_upsert_video_view.sql
│   │   ├── 20260228_01_dashboard_aggregation_triggers.sql
│   │   ├── 20260228_02_summary_blocks.sql
│   │   ├── 20260228_03_keyword_connections_relationship.sql
│   │   └── 20260302_01_performance_indexes.sql    ← NEW: composite indexes
│   └── functions/server/               ← Edge Function (Hono + Deno)
│       ├── index.ts                    ← ENTRYPOINT: mounts all routes + middleware
│       ├── db.ts                       ← Supabase clients, auth, response helpers
│       ├── crud-factory.ts             ← Generic CRUD route generator
│       ├── validate.ts                 ← Type guards + declarative field validator
│       ├── rate-limit.ts               ← In-memory sliding window rate limiter
│       ├── timing-safe.ts              ← Constant-time string comparison
│       │
│       ├── routes-auth.tsx             ← Auth & profiles (6KB)
│       ├── routes-billing.tsx          ← Stripe integration (15KB)
│       ├── routes-content.tsx          ← Content hierarchy (17KB) — monolith
│       ├── routes-members.tsx          ← Institutions + memberships + scopes (17KB)
│       ├── routes-models.tsx           ← 3D models, pins, notes (2KB)
│       ├── routes-mux.ts              ← Mux video integration (17KB)
│       ├── routes-plans.tsx            ← Plans, AI generations, diagnostics (13KB)
│       ├── routes-search.ts            ← Global search + trash + restore (13KB)
│       ├── routes-storage.tsx          ← File upload/download/delete (9KB)
│       ├── routes-student.tsx          ← Student instruments & notes (6KB)
│       ├── routes-study-queue.tsx      ← Study queue algorithm (15KB)
│       ├── routes-study.tsx            ← Study system (23KB) — monolith (includes topic-progress)
│       │
│       ├── __tests__/                  ← ⚠️ Jest-style tests (3 files — needs cleanup)
│       │   ├── rate-limit.test.ts
│       │   ├── timing-safe.test.ts
│       │   └── validate.test.ts
│       └── tests/                      ← Deno-native tests (2 files)
│           ├── rate_limit_test.ts
│           └── validate_test.ts
└── README.md
```

---

## ⚠️ Pending Cleanup (PR #2 — not yet merged)

PR [#2](https://github.com/Matraca130/axon-backend/pull/2) on branch `refactor/organize-backend` was deploy-tested (green ✅) but not yet merged. When merged, it will:

1. **Split `routes-content.tsx`** (17KB) → `routes/content/` (5 files)
2. **Split `routes-study.tsx`** (23KB) → `routes/study/` (4 files including topic-progress in progress.ts)
3. **Consolidate tests** → Keep `tests/` (Deno), delete `__tests__/` (Jest)
4. **Consolidate migrations** → Move root `migrations/` files into `supabase/migrations/`
5. **Delete old monolith files** → `routes-content.tsx`, `routes-study.tsx`

**Until merged: the current structure is monolithic.**

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

`registerCrud(app, config)` generates 5 endpoints per table.

### `validate.ts` — Runtime Validation

**Type guards:** `isStr`, `isNonEmpty`, `isNum`, `isBool`, `isObj`
**Format validators:** `isUuid`, `isEmail`, `isIsoTs`, `isDateOnly`
**Numeric ranges:** `inRange(v, min, max)`, `isNonNeg`, `isNonNegInt`, `isProbability`
**Enum validator:** `isOneOf(v, values)`
**Declarative batch:** `validateFields(body, rules)`

### `rate-limit.ts` — 120 req/min sliding window
### `timing-safe.ts` — Constant-time comparison for webhook signatures

---

## Route Modules — Complete Endpoint Reference

### `routes-content.tsx` — Content Hierarchy (monolith, 17KB)

**Factory CRUD (9 tables):** `courses`, `semesters`, `sections`, `topics`, `summaries`, `chunks`, `summary-blocks`, `keywords`, `subtopics`

**Manual endpoints:**

| Method | Path | Description |
|---|---|---|
| GET | `/keyword-connections?keyword_id=` | List connections (either side) |
| GET | `/keyword-connections/:id` | Get by ID |
| POST | `/keyword-connections` | Create (enforces a < b) |
| DELETE | `/keyword-connections/:id` | Hard delete |
| GET | `/kw-prof-notes?keyword_id=` | List professor notes |
| GET | `/kw-prof-notes/:id` | Get by ID |
| POST | `/kw-prof-notes` | Upsert (one per prof per keyword) |
| DELETE | `/kw-prof-notes/:id` | Hard delete |
| PUT | `/reorder` | Bulk reorder (M-3: uses DB function) |
| GET | `/content-tree?institution_id=` | Nested hierarchy tree |

### `routes-study.tsx` — Study System (monolith, 23KB)

**Factory CRUD (3 tables):** `study-sessions`, `study-plans`, `study-plan-tasks`

**Unified endpoint (NEW — speed optimization):**

| Method | Path | Description |
|---|---|---|
| GET | `/topic-progress?topic_id=` | **Summaries + reading states + flashcard counts in 1 request.** Replaces N+1 pattern (1+2N → 1). Server does 3 parallel queries. |

**Manual endpoints:**

| Method | Path | Description |
|---|---|---|
| GET | `/reviews?session_id=` | List reviews (O-3: session ownership) |
| POST | `/reviews` | Create review (grade 0-5) |
| GET | `/quiz-attempts?quiz_question_id=&session_id=` | List attempts |
| POST | `/quiz-attempts` | Create attempt |
| GET | `/reading-states?summary_id=` | Get reading state |
| POST | `/reading-states` | Upsert reading state |
| GET | `/daily-activities?from=&to=` | List daily activities (P-2: capped 500) |
| POST | `/daily-activities` | Upsert daily activity |
| GET | `/student-stats` | Get student stats |
| POST | `/student-stats` | Upsert student stats |
| GET | `/fsrs-states?flashcard_id=&state=&due_before=` | List FSRS states (P-2: capped 500) |
| POST | `/fsrs-states` | Upsert FSRS state |
| GET | `/bkt-states?subtopic_id=` | List BKT states (P-2: capped 500) |
| POST | `/bkt-states` | Upsert BKT state |

### Other Route Modules

- **`routes-auth.tsx`** (6KB): `/signup`, `/me` (GET/PUT)
- **`routes-members.tsx`** (17KB): `/institutions`, `/memberships`, `/admin-scopes`
- **`routes-billing.tsx`** (15KB): `/billing/checkout-session`, `/billing/portal-session`, `/billing/subscription-status`, `/webhooks/stripe`
- **`routes-mux.ts`** (17KB): `/mux/create-upload`, `/mux/playback-token`, `/mux/track-view`, `/mux/video-stats`, `/mux/asset/:video_id`, `/webhooks/mux`
- **`routes-plans.tsx`** (13KB): `platform-plans`, `institution-plans`, `plan-access-rules`, `institution-subscriptions`, `/ai-generations`, `/summary-diagnostics`, `/content-access`, `/usage-today`
- **`routes-search.ts`** (13KB): `/search`, `/trash`, `/restore/:table/:id`
- **`routes-storage.tsx`** (9KB): `/storage/upload`, `/storage/signed-url`, `/storage/delete`
- **`routes-student.tsx`** (6KB): `flashcards`, `quiz-questions`, `student-notes`, `student-annotations`, `videos`, `highlight-tags`
- **`routes-models.tsx`** (2KB): `models-3d`, `model-3d-pins`, `model-3d-notes`
- **`routes-study-queue.tsx`** (15KB): `/study-queue` (custom algorithm)

---

## Migrations Inventory

### `supabase/migrations/` (primary — 9 files)

| File | Code | Status | Description |
|---|---|---|---|
| `20260224_01` | EV-9 | ✅ Applied | Mux columns on videos table |
| `20260224_02` | EV-9 | ✅ Applied | video_views table + indexes |
| `20260227_01` | M-3 | ✅ Applied | bulk_reorder() DB function |
| `20260227_02` | — | ✅ Applied | get_course_summary_ids() helper |
| `20260227_03` | N-7 | ✅ Applied | upsert_video_view() atomic function |
| `20260228_01` | — | ✅ Applied | Dashboard aggregation triggers + backfill |
| `20260228_02` | — | ✅ Applied | summary_blocks table |
| `20260228_03` | — | ✅ Applied | keyword_connections.relationship column |
| `20260302_01` | — | ⚠️ PENDING | Composite/partial indexes for high-read tables |

### `migrations/` root (⚠️ needs cleanup)

| File | Code | Status | Description |
|---|---|---|---|
| `20260227_03` | N-7 | Duplicate | Can delete |
| `20260227_04` | N-5 | ⚠️ NOT IN supabase/migrations/ | get_content_tree() RPC |
| `20260227_05` | O-4 | ⚠️ NOT IN supabase/migrations/ | Trigram indexes |
| `20260227_06` | O-7 | ⚠️ NOT IN supabase/migrations/ | processed_webhook_events table |

---

## Security Fixes Log

### N-series (Network/Performance)
| Code | Fix | File |
|---|---|---|
| N-1 | Search queries run in parallel | routes-search.ts |
| N-2 | Trash queries run in parallel | routes-search.ts |
| N-5 | Content tree DB function (RPC with graceful fallback) | routes-content.tsx |
| N-6 | Auto-profile fetches metadata via admin.auth | routes-auth.tsx |
| N-7 | Atomic upsert_video_view (no race condition) | routes-mux.ts |
| N-8 | escapeLike() sanitizes SQL wildcards | routes-search.ts |
| N-10 | Timing-safe Stripe signature verification | routes-billing.tsx |
| **NEW** | **topic-progress unified endpoint (N+1→1)** | **routes-study.tsx** |

### O-series (Security/Safety)
| Code | Fix | File |
|---|---|---|
| O-1 | or() filter values quoted (injection-safe) | routes-search.ts |
| O-2 | signed-url and delete use safeJson() | routes-storage.tsx |
| O-3 | Session ownership verification for reviews | routes-study.tsx |
| O-4 | Trigram indexes for search performance | migrations/20260227_05 |
| O-6 | base64 upload wraps atob() in try/catch | routes-storage.tsx |
| O-7 | Webhook idempotency via event tracking | routes-billing.tsx, routes-mux.ts |
| O-8 | Rate limiting middleware (120 req/min) | rate-limit.ts, index.ts |

### P-series (Polish/Validation)
| Code | Fix | File |
|---|---|---|
| P-1 | Full Course>Semester>Topic>Summary path resolution | routes-search.ts |
| P-2 | Pagination capped at 500 items | routes-plans.tsx, routes-study.tsx |
| P-3 | Double quotes escaped in PostgREST or() | routes-search.ts |
| P-4 | Upload JSON path uses safeJson() | routes-storage.tsx |
| P-5 | Password max length capped at 128 | routes-auth.tsx |
| P-6 | Auto-profile uses upsert (race condition) | routes-auth.tsx |
| P-7 | Signed URL batch capped at 100 paths | routes-storage.tsx |
| P-8 | usage-today uses proper tomorrow boundary | routes-plans.tsx |

---

## Environment Variables

| Variable | Required | Used by |
|---|---|---|
| `SUPABASE_URL` | Yes | db.ts |
| `SUPABASE_ANON_KEY` | Yes | db.ts |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | db.ts |
| `STRIPE_SECRET_KEY` | For billing | routes-billing.tsx |
| `STRIPE_WEBHOOK_SECRET` | For billing | routes-billing.tsx |
| `MUX_TOKEN_ID` | For video | routes-mux.ts |
| `MUX_TOKEN_SECRET` | For video | routes-mux.ts |
| `MUX_WEBHOOK_SECRET` | For video | routes-mux.ts |
| `MUX_SIGNING_KEY_ID` | For video | routes-mux.ts |
| `MUX_SIGNING_KEY_SECRET` | For video | routes-mux.ts |

---

## Tests

⚠️ **Two test directories exist** (pending consolidation in PR #2):

### `__tests__/` (Jest-style — 3 files)
`rate-limit.test.ts`, `timing-safe.test.ts`, `validate.test.ts`

### `tests/` (Deno-native — 2 files)
`rate_limit_test.ts`, `validate_test.ts`

---

## Refactoring History

### 2026-03-03: topic-progress unified endpoint
- Added `GET /topic-progress?topic_id=xxx` to `routes-study.tsx`
- Replaces N+1 pattern: 1+2N requests → 1 request
- Server does 3 parallel queries: summaries + reading_states (batch .in()) + flashcards (batch .in())
- No schema changes needed
- Branch `refactor/organize-backend` updated to include this in `routes/study/progress.ts`

### 2026-03-02: Performance indexes
- Added `20260302_01_performance_indexes.sql` with 15 composite/partial indexes
- Estimated 1000x query speedup at 20M rows

### 2026-03-02: PR #2 — organize-backend (NOT YET MERGED)
- Split content (17KB) → 5 files, study (23KB) → 4 files
- Consolidate tests + migrations
- Deploy-tested from branch (green ✅)
