# Axon Backend Map

> Single source of truth for navigating the `axon-backend` repository.
> Last updated: 2026-03-03 (post refactor/organize-backend-v3)

## Repository Structure

```
axon-backend/
├── .github/workflows/deploy.yml       ← GitHub Actions: deploy to Supabase on push to main
├── docs/
│   ├── AGENT_INDEX.md                  ← Quick lookup for agents (start here)
│   ├── AGENT_RULES.md                  ← Critical rules for AI agents
│   ├── BACKEND_AUDIT.md                ← Historical audit (Feb 2026)
│   ├── BACKEND_MAP.md                  ← THIS FILE
│   └── figma-make/                     ← Figma Make context docs (6 files)
├── migrations/                         ← ⚠️ LEGACY — delete after verifying supabase/migrations/
├── supabase/
│   ├── migrations/                     ← PRIMARY migrations (13 files)
│   └── functions/server/               ← Edge Function (Hono + Deno)
│       ├── index.ts                    ← ENTRYPOINT: mounts all routes + middleware
│       ├── db.ts                       ← Supabase clients, auth, response helpers
│       ├── crud-factory.ts             ← Generic CRUD route generator
│       ├── validate.ts                 ← Type guards + declarative field validator
│       ├── rate-limit.ts               ← In-memory sliding window rate limiter
│       ├── timing-safe.ts              ← Constant-time string comparison
│       │
│       ├── routes/                     ← MODULAR ROUTE SYSTEM
│       │   ├── content/                ← Content hierarchy (was 17KB monolith)
│       │   │   ├── index.ts            ← Module combiner
│       │   │   ├── crud.ts             ← 9 registerCrud calls (courses→subtopics)
│       │   │   ├── keyword-connections.ts  ← Manual CRUD for keyword_connections
│       │   │   ├── prof-notes.ts       ← Manual CRUD for kw_prof_notes
│       │   │   ├── reorder.ts          ← PUT /reorder (bulk, M-3 RPC)
│       │   │   └── content-tree.ts     ← GET /content-tree (nested hierarchy)
│       │   ├── study/                  ← Study system (was 27KB monolith)
│       │   │   ├── index.ts            ← Module combiner
│       │   │   ├── sessions.ts         ← 3 CRUDs: study-sessions, plans, tasks
│       │   │   ├── reviews.ts          ← Reviews + quiz-attempts (O-3 ownership)
│       │   │   ├── progress.ts         ← topic-progress, topics-overview, reading-states, daily-activities, student-stats
│       │   │   └── spaced-rep.ts       ← FSRS + BKT state upserts
│       │   ├── members/                ← Institutions + memberships (was 17KB)
│       │   │   ├── index.ts
│       │   │   ├── institutions.ts     ← 5 endpoints (CRUD + owner membership)
│       │   │   ├── memberships.ts      ← 5 endpoints (CRUD + admin client)
│       │   │   └── admin-scopes.ts     ← 3 endpoints (GET/POST/DELETE)
│       │   ├── mux/                    ← Mux video integration (was 17KB)
│       │   │   ├── index.ts
│       │   │   ├── helpers.ts          ← muxFetch, verifyWebhook, buildJWT, completionSignal
│       │   │   ├── api.ts              ← create-upload, playback-token, video-stats, delete
│       │   │   ├── webhook.ts          ← POST /webhooks/mux (HMAC, no auth)
│       │   │   └── tracking.ts         ← POST /mux/track-view (N-7 atomic)
│       │   ├── plans/                  ← Plans + AI + diagnostics (was 13KB)
│       │   │   ├── index.ts
│       │   │   ├── crud.ts             ← 4 registerCrud calls
│       │   │   ├── ai-generations.ts   ← AI audit log (LIST + POST)
│       │   │   ├── diagnostics.ts      ← Summary diagnostics (LIST + POST)
│       │   │   └── access.ts           ← content-access + usage-today
│       │   └── search/                 ← Global search + trash (was 13KB)
│       │       ├── index.ts
│       │       ├── helpers.ts          ← escapeLike, escapeOrQuote, batchResolvePaths
│       │       ├── search.ts           ← GET /search (N-1 parallel queries)
│       │       └── trash-restore.ts    ← GET /trash + POST /restore
│       │
│       ├── routes-auth.tsx             ← Auth & profiles (6KB) — small, no split needed
│       ├── routes-billing.tsx          ← Stripe integration (15KB) — split pending
│       ├── routes-models.tsx           ← 3D models, pins, notes (2KB) — small
│       ├── routes-storage.tsx          ← File upload/download/delete (9KB)
│       ├── routes-student.tsx          ← Student instruments & notes (6KB)
│       ├── routes-study-queue.tsx      ← Study queue algorithm (15KB) — single complex endpoint
│       │
│       ├── routes-content.tsx          ← THIN RE-EXPORT → routes/content/
│       ├── routes-study.tsx            ← THIN RE-EXPORT → routes/study/
│       ├── routes-members.tsx          ← THIN RE-EXPORT → routes/members/
│       ├── routes-mux.ts              ← THIN RE-EXPORT → routes/mux/
│       ├── routes-plans.tsx            ← THIN RE-EXPORT → routes/plans/
│       ├── routes-search.ts            ← THIN RE-EXPORT → routes/search/
│       │
│       ├── tests/                      ← Deno-native tests (3 files)
│       │   ├── rate_limit_test.ts
│       │   ├── validate_test.ts
│       │   └── timing_safe_test.ts     ← NEW (consolidated from __tests__/)
│       └── __tests__/                  ← ⚠️ LEGACY Jest-style — delete after merge
└── README.md
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

### `routes/content/` — Content Hierarchy (6 files)

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
| PUT | `/reorder` | reorder.ts | Bulk reorder (M-3: uses DB function) |
| GET | `/content-tree?institution_id=` | content-tree.ts | Nested hierarchy tree |

### `routes/study/` — Study System (5 files)

**Factory CRUD (3 tables):** `study-sessions`, `study-plans`, `study-plan-tasks`

**Unified endpoints (N+1 killers):**

| Method | Path | File | Description |
|---|---|---|---|
| GET | `/topic-progress?topic_id=` | progress.ts | Summaries + reading states + flashcard counts in 1 request (was 1+2N) |
| GET | `/topics-overview?topic_ids=a,b,c` | progress.ts | Summaries by topic + keyword counts, batch max 50 (was T+T×S) |

**Manual endpoints:**

| Method | Path | File | Description |
|---|---|---|---|
| GET/POST | `/reviews` | reviews.ts | O-3: session ownership verification |
| GET/POST | `/quiz-attempts` | reviews.ts | Student quiz answers |
| GET/POST | `/reading-states` | progress.ts | Per-summary reading progress |
| GET/POST | `/daily-activities` | progress.ts | P-2: capped 500 |
| GET/POST | `/student-stats` | progress.ts | Aggregated stats |
| GET/POST | `/fsrs-states` | spaced-rep.ts | P-2: capped 500 |
| GET/POST | `/bkt-states` | spaced-rep.ts | P-2: capped 500 |

### `routes/members/` — Institutions & Memberships (4 files)

| Method | Path | File | Description |
|---|---|---|---|
| POST | `/institutions` | institutions.ts | Create + owner membership (admin client) |
| GET | `/institutions` | institutions.ts | List user's institutions |
| GET/PUT/DELETE | `/institutions/:id` | institutions.ts | CRUD |
| GET | `/memberships?institution_id=` | memberships.ts | List members |
| GET/POST/PUT/DELETE | `/memberships(/:id)` | memberships.ts | CRUD |
| GET | `/admin-scopes?membership_id=` | admin-scopes.ts | List scopes |
| POST/DELETE | `/admin-scopes(/:id)` | admin-scopes.ts | Add/remove scope |

### `routes/mux/` — Mux Video Integration (5 files)

| Method | Path | File | Description |
|---|---|---|---|
| POST | `/mux/create-upload` | api.ts | Direct upload to Mux |
| GET | `/mux/playback-token?video_id=` | api.ts | Signed JWT (RS256) |
| GET | `/mux/video-stats?video_id=` | api.ts | Aggregated viewer stats |
| DELETE | `/mux/asset/:video_id` | api.ts | Mux delete + soft-delete |
| POST | `/mux/track-view` | tracking.ts | N-7: atomic upsert_video_view() |
| POST | `/webhooks/mux` | webhook.ts | HMAC-verified, no auth |

### `routes/plans/` — Plans & AI Logs (5 files)

**Factory CRUD (4 tables):** `platform-plans`, `institution-plans`, `plan-access-rules`, `institution-subscriptions`

| Method | Path | File | Description |
|---|---|---|---|
| GET/POST | `/ai-generations` | ai-generations.ts | P-2: capped 500 |
| GET/POST | `/summary-diagnostics` | diagnostics.ts | AI diagnostic results |
| GET | `/content-access?user_id=&institution_id=` | access.ts | Subscription + plan rules |
| GET | `/usage-today?user_id=&institution_id=` | access.ts | P-8: proper date boundary |

### `routes/search/` — Global Search & Trash (4 files)

| Method | Path | File | Description |
|---|---|---|---|
| GET | `/search?q=&type=` | search.ts | N-1: parallel queries, O-1/P-3: safe quoting |
| GET | `/trash?type=` | trash-restore.ts | N-2: parallel trash queries |
| POST | `/restore/:table/:id` | trash-restore.ts | Role-restricted restore |

### Non-split Route Files

| File | Size | Endpoints | Why not split |
|---|---|---|---|
| `routes-auth.tsx` | 6KB | `/signup`, `/me` (GET/PUT) | Small, cohesive |
| `routes-billing.tsx` | 15KB | Stripe checkout/portal/webhooks | Split pending |
| `routes-models.tsx` | 2KB | 3D models, pins, notes (3 CRUDs) | Tiny |
| `routes-storage.tsx` | 9KB | upload, signed-url, delete | Moderate, cohesive |
| `routes-student.tsx` | 6KB | flashcards, quiz-questions, notes, etc. | Small |
| `routes-study-queue.tsx` | 15KB | GET /study-queue (single algorithmic endpoint) | One complex function |

---

## Migrations Inventory

### `supabase/migrations/` (primary — 13 files)

| File | Code | Status | Description |
|---|---|---|---|
| `20260224_01` | EV-9 | ✅ Applied | Mux columns on videos table |
| `20260224_02` | EV-9 | ✅ Applied | video_views table + indexes |
| `20260227_01` | M-3 | ✅ Applied | bulk_reorder() DB function |
| `20260227_02` | — | ✅ Applied | get_course_summary_ids() helper |
| `20260227_03` | N-7 | ✅ Applied | upsert_video_view() atomic function |
| `20260227_04` | N-5 | ⚠️ PENDING | get_content_tree() RPC |
| `20260227_05` | O-4 | ⚠️ PENDING | Trigram indexes for search |
| `20260227_06` | O-7 | ⚠️ PENDING | processed_webhook_events table |
| `20260228_01` | — | ✅ Applied | Dashboard aggregation triggers |
| `20260228_02` | — | ✅ Applied | summary_blocks table |
| `20260228_03` | — | ✅ Applied | keyword_connections.relationship |
| `20260302_01` | — | ⚠️ PENDING | Composite/partial performance indexes |
| `20260303_01` | — | ✅ Applied | estimated_study_minutes column |

### `migrations/` root (⚠️ LEGACY — delete after merge)

All 3 unique files have been copied to `supabase/migrations/`. The duplicate `_03` and the originals can be safely deleted.

---

## Tests

### `tests/` (Deno-native — 3 files) ✅ CANONICAL
`rate_limit_test.ts`, `validate_test.ts`, `timing_safe_test.ts`

### `__tests__/` (⚠️ LEGACY Jest-style — delete after merge)
`rate-limit.test.ts`, `timing-safe.test.ts`, `validate.test.ts`

---

## Environment Variables

| Variable | Required | Used by |
|---|---|---|
| `SUPABASE_URL` | Yes | db.ts |
| `SUPABASE_ANON_KEY` | Yes | db.ts |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | db.ts |
| `STRIPE_SECRET_KEY` | For billing | routes-billing.tsx |
| `STRIPE_WEBHOOK_SECRET` | For billing | routes-billing.tsx |
| `MUX_TOKEN_ID` | For video | routes/mux/helpers.ts |
| `MUX_TOKEN_SECRET` | For video | routes/mux/helpers.ts |
| `MUX_WEBHOOK_SECRET` | For video | routes/mux/helpers.ts |
| `MUX_SIGNING_KEY_ID` | For video | routes/mux/helpers.ts |
| `MUX_SIGNING_KEY_SECRET` | For video | routes/mux/helpers.ts |

---

## Post-Merge Cleanup Checklist

After merging `refactor/organize-backend-v3` → `main`:

- [ ] Delete `migrations/` root directory (all content now in `supabase/migrations/`)
- [ ] Delete `__tests__/` directory (all tests now in `tests/`)
- [ ] Delete thin re-export files (optional — they're tiny and harmless):
      `routes-content.tsx`, `routes-study.tsx`, `routes-members.tsx`,
      `routes-mux.ts`, `routes-plans.tsx`, `routes-search.ts`
- [ ] Apply pending migrations: `_04`, `_05`, `_06`, `20260302_01`
- [ ] Close old PR from `refactor/organize-backend-v2`
- [ ] Delete branches: `v1`, `v2`
- [ ] Consider splitting `routes-billing.tsx` (15KB) in a future PR
