# Axon Backend Map

> Single source of truth for navigating the `axon-backend` repository.
> Last updated: 2026-03-02 (refactor/organize-backend PR #2)

## Repository Structure

```
axon-backend/
├── .github/workflows/deploy.yml       ← GitHub Actions: deploy to Supabase on push to main
├── docs/
│   ├── AGENT_RULES.md                  ← Rules for AI agents working on this repo
│   └── BACKEND_MAP.md                  ← THIS FILE
├── supabase/
│   ├── migrations/                     ← SQL migrations (SINGLE location)
│   │   ├── 20260224_01_videos_mux_columns.sql
│   │   ├── 20260224_02_video_views.sql
│   │   ├── 20260227_01_bulk_reorder.sql
│   │   ├── 20260227_02_get_course_summary_ids.sql
│   │   ├── 20260227_03_upsert_video_view.sql
│   │   ├── 20260227_04_content_tree_rpc.sql
│   │   ├── 20260227_05_trigram_indexes.sql
│   │   ├── 20260227_06_webhook_events_table.sql
│   │   ├── 20260228_01_dashboard_aggregation_triggers.sql
│   │   ├── 20260228_02_summary_blocks.sql
│   │   └── 20260228_03_keyword_connections_relationship.sql
│   └── functions/server/               ← Edge Function (Hono + Deno)
│       ├── index.ts                    ← ENTRYPOINT: mounts all routes + middleware
│       ├── db.ts                       ← Supabase clients, auth, response helpers
│       ├── crud-factory.ts             ← Generic CRUD route generator
│       ├── validate.ts                 ← Type guards + declarative field validator
│       ├── rate-limit.ts               ← In-memory sliding window rate limiter
│       ├── timing-safe.ts              ← Constant-time string comparison
│       │
│       ├── routes/                     ← Organized route modules
│       │   ├── content/                ← Content hierarchy (was routes-content.tsx)
│       │   │   ├── index.ts            ← Combiner
│       │   │   ├── crud.ts             ← 10 registerCrud calls
│       │   │   ├── keyword-connections.ts
│       │   │   ├── prof-notes.ts
│       │   │   ├── reorder.ts
│       │   │   └── content-tree.ts
│       │   └── study/                  ← Study system (was routes-study.tsx)
│       │       ├── index.ts            ← Combiner
│       │       ├── sessions.ts         ← study-sessions, plans, tasks
│       │       ├── reviews.ts          ← reviews + quiz-attempts
│       │       ├── progress.ts         ← reading-states, daily-activities, stats
│       │       └── spaced-rep.ts       ← fsrs-states, bkt-states
│       │
│       ├── routes-auth.tsx             ← Auth & profiles (6KB)
│       ├── routes-billing.tsx          ← Stripe integration (15KB)
│       ├── routes-members.tsx          ← Institutions + memberships + scopes (17KB)
│       ├── routes-models.tsx           ← 3D models, pins, notes (2KB)
│       ├── routes-mux.ts              ← Mux video integration (17KB)
│       ├── routes-plans.tsx            ← Plans, AI generations, diagnostics (13KB)
│       ├── routes-search.ts            ← Global search + trash + restore (13KB)
│       ├── routes-storage.tsx          ← File upload/download/delete (9KB)
│       ├── routes-student.tsx          ← Student instruments & notes (6KB)
│       ├── routes-study-queue.tsx      ← Study queue algorithm (15KB)
│       │
│       └── tests/                      ← Deno-native tests (SINGLE location)
│           ├── rate_limit_test.ts
│           ├── timing_safe_test.ts
│           └── validate_test.ts
└── README.md
```

---

## Infrastructure Files

### `db.ts` — Core Auth & Database (8KB)

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

**Auth strategy:** JWT decoded locally for speed. Cryptographic validation deferred to PostgREST/RLS on every DB query. For admin-only routes, use `getAdminClient().auth.getUser(token)` for verified auth.

### `crud-factory.ts` — Generic CRUD Generator (10KB)

`registerCrud(app, config)` generates 5 endpoints per table:
- `GET /{slug}?{parentKey}=xxx` — LIST with optional filters
- `GET /{slug}/:id` — GET by ID
- `POST /{slug}` — CREATE
- `PUT /{slug}/:id` — UPDATE
- `DELETE /{slug}/:id` — DELETE (soft or hard)

Config options: `table`, `slug`, `parentKey`, `scopeToUser`, `softDelete`, `hasCreatedBy`, `hasUpdatedAt`, `hasOrderIndex`, `hasIsActive`, `requiredFields`, `createFields`, `updateFields`, `optionalFilters`.

### `validate.ts` — Runtime Validation (5KB)

**Type guards:** `isStr`, `isNonEmpty`, `isNum`, `isBool`, `isObj`
**Format validators:** `isUuid`, `isEmail`, `isIsoTs`, `isDateOnly`
**Numeric ranges:** `inRange(v, min, max)`, `isNonNeg`, `isNonNegInt`, `isProbability`
**Enum validator:** `isOneOf(v, values)`
**Declarative batch:** `validateFields(body, rules)` — validates + picks fields in one call

### `rate-limit.ts` — Rate Limiter Middleware (4KB)

- Sliding window: 120 requests/minute per user
- In-memory Map keyed by JWT prefix
- Exemptions: `/health` and `/webhooks/`
- Periodic cleanup every 5 minutes

### `timing-safe.ts` — Constant-time Comparison (1KB)

`timingSafeEqual(a, b)` — prevents timing attacks on webhook signature verification.

---

## Route Modules — Complete Endpoint Reference

### `routes/content/` — Content Hierarchy

**Factory CRUD endpoints (10 tables):**

| Slug | Table | Parent Key | Features |
|---|---|---|---|
| `courses` | courses | `institution_id` | soft-delete, created_by, order_index |
| `semesters` | semesters | `course_id` | soft-delete, created_by, order_index |
| `sections` | sections | `semester_id` | soft-delete, created_by, order_index |
| `topics` | topics | `section_id` | soft-delete, created_by, order_index |
| `summaries` | summaries | `topic_id` | soft-delete, created_by, order_index |
| `chunks` | chunks | `summary_id` | order_index only |
| `summary-blocks` | summary_blocks | `summary_id` | order_index, is_active |
| `keywords` | keywords | `summary_id` | soft-delete, created_by |
| `subtopics` | subtopics | `keyword_id` | soft-delete, order_index |

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
| PUT | `/reorder` | reorder.ts | Bulk reorder (M-3: uses DB function) |
| GET | `/content-tree?institution_id=` | content-tree.ts | Nested hierarchy tree |

### `routes/study/` — Study System

**Factory CRUD endpoints (3 tables):**

| Slug | Table | Scope | Features |
|---|---|---|---|
| `study-sessions` | study_sessions | `student_id` | filters: course_id, session_type |
| `study-plans` | study_plans | `student_id` | filters: course_id, status; updated_at |
| `study-plan-tasks` | study_plan_tasks | `study_plan_id` | order_index |

**Manual endpoints:**

| Method | Path | File | Description |
|---|---|---|---|
| GET | `/reviews?session_id=` | reviews.ts | List reviews (O-3: session ownership) |
| POST | `/reviews` | reviews.ts | Create review (grade 0-5) |
| GET | `/quiz-attempts?quiz_question_id=&session_id=` | reviews.ts | List attempts |
| POST | `/quiz-attempts` | reviews.ts | Create attempt |
| GET | `/reading-states?summary_id=` | progress.ts | Get reading state |
| POST | `/reading-states` | progress.ts | Upsert reading state |
| GET | `/daily-activities?from=&to=` | progress.ts | List daily activities |
| POST | `/daily-activities` | progress.ts | Upsert daily activity |
| GET | `/student-stats` | progress.ts | Get student stats |
| POST | `/student-stats` | progress.ts | Upsert student stats |
| GET | `/fsrs-states?flashcard_id=&state=&due_before=` | spaced-rep.ts | List FSRS states |
| POST | `/fsrs-states` | spaced-rep.ts | Upsert FSRS state |
| GET | `/bkt-states?subtopic_id=` | spaced-rep.ts | List BKT states |
| POST | `/bkt-states` | spaced-rep.ts | Upsert BKT state |

### `routes-auth.tsx` — Authentication & Profiles (6KB)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/signup` | none | Register user (admin client) |
| GET | `/me` | user | Get profile (auto-creates if missing, P-6: upsert) |
| PUT | `/me` | user | Update profile (full_name, avatar_url) |

### `routes-members.tsx` — Institutions & Memberships (17KB)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/institutions` | user | Create institution + owner membership |
| GET | `/institutions` | user | List user's institutions (via memberships) |
| GET | `/institutions/:id` | user | Get by ID |
| PUT | `/institutions/:id` | user | Update (RLS: owner/admin) |
| DELETE | `/institutions/:id` | user | Soft-deactivate |
| GET | `/memberships?institution_id=` | user | List memberships |
| GET | `/memberships/:id` | user | Get by ID |
| POST | `/memberships` | user | Add member (admin client) |
| PUT | `/memberships/:id` | user | Update role/plan/active |
| DELETE | `/memberships/:id` | user | Soft-deactivate |
| GET | `/admin-scopes?membership_id=` | user | List scopes |
| POST | `/admin-scopes` | user | Add scope |
| DELETE | `/admin-scopes/:id` | user | Remove scope (hard delete) |

### `routes-billing.tsx` — Stripe Integration (15KB)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/billing/checkout-session` | user | Create Stripe checkout |
| POST | `/billing/portal-session` | user | Create Stripe portal |
| POST | `/webhooks/stripe` | HMAC | Webhook (N-10: timing-safe, O-7: idempotency) |
| GET | `/billing/subscription-status?user_id=&institution_id=` | user | Subscription status |

### `routes-mux.ts` — Mux Video (17KB)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/mux/create-upload` | user | Create direct upload URL + pending video row |
| POST | `/webhooks/mux` | HMAC | Webhook (asset.ready / asset.errored) |
| GET | `/mux/playback-token?video_id=` | user | Signed JWT for playback (v/t/s tokens) |
| POST | `/mux/track-view` | user | Upsert video view (N-7: atomic DB function) |
| GET | `/mux/video-stats?video_id=` | user | Aggregated stats for professor |
| DELETE | `/mux/asset/:video_id` | user | Delete from Mux + soft-delete in DB |

### `routes-plans.tsx` — Plans & AI (13KB)

**Factory CRUD (4 tables):** `platform-plans`, `institution-plans`, `plan-access-rules`, `institution-subscriptions`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/ai-generations?institution_id=` | user | List AI generation logs (P-2: capped 500) |
| POST | `/ai-generations` | user | Create AI generation log |
| GET | `/summary-diagnostics?summary_id=` | user | List diagnostics |
| POST | `/summary-diagnostics` | user | Create diagnostic |
| GET | `/content-access?user_id=&institution_id=` | user | Check plan-based content access |
| GET | `/usage-today?user_id=&institution_id=` | user | Today's usage counts (P-8: proper dates) |

### `routes-search.ts` — Search & Trash (13KB)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/search?q=&type=` | user | Global search (N-1: parallel, O-1: injection-safe, P-1: full paths) |
| GET | `/trash?type=` | user | List soft-deleted items (N-2: parallel) |
| POST | `/restore/:table/:id` | user | Restore soft-deleted item (role-restricted) |

### `routes-storage.tsx` — File Storage (9KB)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/storage/upload` | user | Upload image (multipart or base64 JSON) |
| POST | `/storage/signed-url` | user | Get signed URL(s) (P-7: batch capped 100) |
| DELETE | `/storage/delete` | user | Delete file(s) (ownership enforced) |

### `routes-student.tsx` — Student Instruments (6KB)

**Factory CRUD (6 tables):**

| Slug | Table | Parent Key | Scope |
|---|---|---|---|
| `flashcards` | flashcards | `summary_id` | created_by, soft-delete, order_index |
| `quiz-questions` | quiz_questions | `summary_id` | created_by, soft-delete |
| `student-notes` | student_notes | `summary_id` | student_id, soft-delete |
| `student-annotations` | student_annotations | `summary_id` | student_id |
| `videos` | videos | `summary_id` | created_by, soft-delete, order_index |
| `highlight-tags` | highlight_tags | `student_id` | none |

### `routes-models.tsx` — 3D Models (2KB)

**Factory CRUD (3 tables):** `models-3d` (topic_id), `model-3d-pins` (model_id), `model-3d-notes` (model_id, student_id scope)

### `routes-study-queue.tsx` — Study Queue Algorithm (15KB)

Custom spaced repetition queue builder.

---

## Migrations Inventory

| File | Code | Status | Description |
|---|---|---|---|
| `20260224_01` | EV-9 | Applied | Mux columns on videos table |
| `20260224_02` | EV-9 | Applied | video_views table + indexes |
| `20260227_01` | M-3 | Applied | bulk_reorder() DB function |
| `20260227_02` | — | Applied | get_course_summary_ids() helper |
| `20260227_03` | N-7 | Applied | upsert_video_view() atomic function |
| `20260227_04` | N-5 | PENDING | get_content_tree() — server-side tree builder |
| `20260227_05` | O-4 | PENDING | Trigram indexes for ILIKE search |
| `20260227_06` | O-7 | PENDING | processed_webhook_events table |
| `20260228_01` | — | Applied | Dashboard aggregation triggers |
| `20260228_02` | — | Applied | summary_blocks table |
| `20260228_03` | — | Applied | keyword_connections.relationship column |

---

## Security Fixes Log

### N-series (Network/Performance)
| Code | Fix | File |
|---|---|---|
| N-1 | Search queries run in parallel | routes-search.ts |
| N-2 | Trash queries run in parallel | routes-search.ts |
| N-5 | Content tree DB function (pending migration) | 20260227_04 |
| N-6 | Auto-profile fetches metadata via admin.auth | routes-auth.tsx |
| N-7 | Atomic upsert_video_view (no race condition) | routes-mux.ts, 20260227_03 |
| N-8 | escapeLike() sanitizes SQL wildcards | routes-search.ts |
| N-10 | Timing-safe Stripe signature verification | routes-billing.tsx |

### O-series (Security/Safety)
| Code | Fix | File |
|---|---|---|
| O-1 | or() filter values quoted (injection-safe) | routes-search.ts |
| O-2 | signed-url and delete use safeJson() | routes-storage.tsx |
| O-3 | Session ownership verification for reviews | routes/study/reviews.ts |
| O-4 | Trigram indexes for search performance | 20260227_05 |
| O-6 | base64 upload wraps atob() in try/catch | routes-storage.tsx |
| O-7 | Webhook idempotency via event tracking | routes-billing.tsx, 20260227_06 |
| O-8 | Rate limiting middleware (120 req/min) | rate-limit.ts |

### P-series (Polish/Validation)
| Code | Fix | File |
|---|---|---|
| P-1 | Full Course>Semester>Topic>Summary path resolution | routes-search.ts |
| P-2 | Pagination capped at 500 items | routes-plans.tsx, routes/study/ |
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

All tests use Deno-native `Deno.test` + `std/assert`. Run with:
```bash
cd supabase/functions/server
deno test tests/
```

| Test file | Covers |
|---|---|
| `rate_limit_test.ts` | Sliding window, cleanup, exemptions |
| `timing_safe_test.ts` | Constant-time comparison, edge cases |
| `validate_test.ts` | All type guards, validateFields, edge cases |

---

## Refactoring History

### 2026-03-02: PR #2 — organize-backend

**What was done:**
1. Split `routes-content.tsx` (18KB, 5 systems) → `routes/content/` (5 files)
2. Split `routes-study.tsx` (20KB, 5+ systems) → `routes/study/` (4 files)
3. Consolidated 2 migration folders (`migrations/` root + `supabase/migrations/`) into 1
4. Consolidated 2 test folders (`__tests__/` Jest + `tests/` Deno) into 1
5. Created this documentation

**What was NOT touched (audited and confirmed well-scoped):**
- `routes-auth.tsx` (6KB) — single domain, small
- `routes-billing.tsx` (15KB) — self-contained Stripe domain
- `routes-members.tsx` (17KB) — tightly coupled institutions/memberships/scopes
- `routes-models.tsx` (2KB) — tiny, 3 factory calls
- `routes-mux.ts` (17KB) — self-contained Mux domain
- `routes-plans.tsx` (13KB) — billing-adjacent concerns
- `routes-search.ts` (13KB) — coherent search/trash domain
- `routes-storage.tsx` (9KB) — self-contained storage
- `routes-student.tsx` (6KB) — clean factory calls
- `routes-study-queue.tsx` (15KB) — self-contained algorithm

**Files deleted (all content preserved elsewhere):**
- `routes-content.tsx` → `routes/content/`
- `routes-study.tsx` → `routes/study/`
- `__tests__/` (3 files) → `tests/` (timing-safe was the only unique, moved)
- `migrations/` root (4 files) → `supabase/migrations/` (3 unique moved, 1 updated)

### Future improvements (not urgent)
- Rename `.tsx` → `.ts` for route files that don't use JSX
- Consider moving `db.ts`, `crud-factory.ts`, `validate.ts` into `core/`
