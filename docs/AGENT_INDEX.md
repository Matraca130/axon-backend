# Agent Quick Index

> **READ THIS FIRST.** This is your navigation map for the axon-backend repo.
> For full details on any section, see [BACKEND_MAP.md](./BACKEND_MAP.md).
> For critical rules, see [AGENT_RULES.md](./AGENT_RULES.md).
> For the AI/RAG pipeline, see [AI_PIPELINE.md](./AI_PIPELINE.md).

---

## "I need to..." Lookup Table

| I need to... | Go to | Notes |
|---|---|---|
| **Add a new CRUD table** | `routes/content/crud.ts` or `routes/study/sessions.ts` or `routes-student.tsx` | Use `registerCrud()` from `crud-factory.ts`. Add one config block. Done. |
| **Add a custom endpoint for content** | `routes/content/` | Content hierarchy: courses->summaries, keywords, reorder, content-tree |
| **Add a custom endpoint for study** | `routes/study/` | Study system: sessions, reviews, progress, topic-progress, spaced-rep |
| **Add a new domain** (auth, billing, etc.) | Create `routes/{domain}/` or `routes-{domain}.ts` | Mount it in `index.ts` |
| **Find how auth works** | `db.ts` | `authenticate(c)` returns `{ user, db }`. See dual-header pattern below |
| **Find how CRUD factory works** | `crud-factory.ts` | Generates LIST/GET/POST/PUT/DELETE from one config object |
| **Add validation** | `validate.ts` | Type guards + `validateFields()` for declarative batch validation |
| **Find an endpoint** | Search table below or `BACKEND_MAP.md` | All routes are flat: `/things?parent_id=xxx` |
| **Add a DB migration** | `supabase/migrations/` | Name: `YYYYMMDD_NN_description.sql`. Mark status in BACKEND_MAP.md |
| **Add a test** | `tests/` (Deno-native) | Run with `deno test supabase/functions/server/tests/` |
| **Check env vars** | `BACKEND_MAP.md` > Environment Variables | Or grep for `Deno.env.get` |
| **Understand the Mux video system** | `routes/mux/` | Upload via @mux/upchunk, playback via signed JWTs |
| **Understand Stripe billing** | `routes-billing.tsx` | Checkout, portal, webhooks (timing-safe + idempotent) |
| **Understand the study algorithm** | `routes-study-queue.tsx` | Custom spaced repetition queue builder |
| **Use AI generation (flashcards/quiz)** | `routes/ai/generate.ts` | POST `/ai/generate` — needs `action` + `summary_id`. See [AI_PIPELINE.md](./AI_PIPELINE.md) |
| **Use RAG Chat (semantic search + answer)** | `routes/ai/chat.ts` | POST `/ai/rag-chat` — needs `message` (NOT `question`). See [AI_PIPELINE.md](./AI_PIPELINE.md) |
| **Ingest embeddings for RAG** | `routes/ai/ingest.ts` | POST `/ai/ingest-embeddings` — needs `institution_id`. Run before RAG Chat works |
| **Change the AI model** | `gemini.ts` | Edit `GENERATE_MODEL` constant. Single source of truth (D-18 fix) |
| **Debug AI/embedding issues** | `routes/ai/list-models.ts` | GET `/ai/list-models` — shows available models for current API key |
| **Understand the RAG pipeline** | [AI_PIPELINE.md](./AI_PIPELINE.md) | Architecture, security model, RPCs, fix history |

---

## File Structure at a Glance

```
supabase/functions/server/
|
|-- index.ts              <- ENTRYPOINT (mounts everything)
|-- db.ts                 <- Auth + Supabase clients + response helpers
|-- crud-factory.ts       <- Generic CRUD generator
|-- validate.ts           <- Type guards + field validation
|-- auth-helpers.ts       <- Role-based access: requireInstitutionRole(), role constants
|-- rate-limit.ts         <- 120 req/min sliding window
|-- timing-safe.ts        <- Constant-time comparison
|-- gemini.ts             <- Gemini API helpers (generateText, generateEmbedding, GENERATE_MODEL)
|
|-- routes/content/       <- Content hierarchy (6 files)
|   |-- index.ts          <- Module combiner
|   |-- crud.ts           <- 9 registerCrud (courses -> subtopics)
|   |-- keyword-connections.ts
|   |-- prof-notes.ts
|   |-- reorder.ts
|   +-- content-tree.ts
|
|-- routes/study/         <- Study system (5 files)
|   |-- index.ts          <- Module combiner
|   |-- sessions.ts       <- 3 registerCrud (sessions, plans, tasks)
|   |-- reviews.ts        <- Reviews + quiz-attempts
|   |-- progress.ts       <- topic-progress, reading-states, daily-activities, student-stats
|   +-- spaced-rep.ts     <- FSRS + BKT states
|
|-- routes/ai/            <- AI / RAG module (5 files)
|   |-- index.ts          <- AI module combiner
|   |-- generate.ts       <- POST /ai/generate (flashcards + quiz questions)
|   |-- ingest.ts         <- POST /ai/ingest-embeddings (batch embeddings)
|   |-- chat.ts           <- POST /ai/rag-chat (semantic search + Gemini)
|   +-- list-models.ts    <- GET /ai/list-models (diagnostic)
|
|-- routes/members/       <- Institutions + memberships (4 files)
|-- routes/mux/           <- Mux video integration (5 files)
|-- routes/plans/         <- Plans + AI logs + access (5 files)
|-- routes/search/        <- Global search + trash (4 files)
|-- routes/settings/      <- Institution settings
|
|-- routes-auth.tsx       <- signup, /me
|-- routes-billing.tsx    <- Stripe checkout/portal/webhooks
|-- routes-models.tsx     <- 3D models (tiny, 3 CRUDs)
|-- routes-storage.tsx    <- File upload/download/delete
|-- routes-student.tsx    <- Flashcards, quizzes, notes, videos
|-- routes-study-queue.tsx <- Study queue algorithm
|
+-- tests/                <- Deno-native tests (3 files)
    |-- rate_limit_test.ts
    |-- validate_test.ts
    +-- timing_safe_test.ts
```

---

## Auth Pattern (Every Request)

```ts
// In any route handler:
const auth = await authenticate(c);
if (auth instanceof Response) return auth; // 401
const { user, db } = auth;
// user.id = UUID of the authenticated user
// db = Supabase client scoped to that user (RLS enforced)
```

Two headers required from frontend:
- `Authorization: Bearer <ANON_KEY>` — passes Supabase gateway
- `X-Access-Token: <USER_JWT>` — identifies the user

---

## Route Convention (CRITICAL)

**ALL routes are FLAT with query params. NEVER nested.**

| WRONG | RIGHT |
|---|---|
| `GET /topics/:id/summaries` | `GET /summaries?topic_id=xxx` |
| `GET /summaries/:id/flashcards` | `GET /flashcards?summary_id=xxx` |
| `GET /courses/:id/semesters` | `GET /semesters?course_id=xxx` |

---

## Common Mistakes to Avoid

1. **Creating nested routes** -> They will 404. Use `?parent_key=value`
2. **Forgetting to mount in index.ts** -> New route files need `app.route("/", newRoutes)`
3. **Using admin client for user operations** -> Use `auth.db` (user-scoped). Only use `getAdminClient()` for admin-only ops
4. **Hardcoding Figma Make URLs** -> Production URL is `https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/server`
5. **Adding YouTube/Vimeo video code** -> Video is Mux-only. No URL fields, no platform selectors, no iframes
6. **Making N+1 requests from frontend** -> Use `/topic-progress` unified endpoint instead of separate calls
7. **Using `question` in RAG Chat** -> The field is `message`, not `question`
8. **Hardcoding model names** -> Import `GENERATE_MODEL` from `gemini.ts`
9. **Calling Gemini before DB query** -> DB query validates JWT cryptographically. Gemini call must come AFTER (PF-05)

---

## AI / RAG Endpoints (in `routes/ai/`)

| Method | Path | Purpose | Key params |
|--------|------|---------|------------|
| POST | `/ai/ingest-embeddings` | Batch-generate embeddings for chunks | `institution_id` (req), `summary_id` (opt), `batch_size` |
| POST | `/ai/generate` | Generate flashcard or quiz question | `action` (req), `summary_id` (req) |
| POST | `/ai/rag-chat` | Semantic search + AI answer | `message` (req), `summary_id` (opt), `history` (opt) |
| GET | `/ai/list-models` | List available Gemini models | — |

### Common mistakes with AI endpoints

| WRONG | RIGHT | Why |
|---|---|---|
| `{ "question": "..." }` in rag-chat | `{ "message": "..." }` | Field is `message`, not `question` |
| Calling `/ai/generate` without `action` | `{ "action": "flashcard", "summary_id": "..." }` | `action` is required |
| Calling `/ai/generate` without `summary_id` | Always include `summary_id` | Required for content context |
| Hardcoding model name in `_meta` | Import `GENERATE_MODEL` from `gemini.ts` | Single source of truth (D-18) |
| Calling Gemini before DB query | DB query first, then Gemini | Security: JWT validated by PostgREST (PF-05) |

> Full reference: [AI_PIPELINE.md](./AI_PIPELINE.md) and [figma-make/06-ai-rag.md](./figma-make/06-ai-rag.md)

---

## Quick Endpoint Finder

### Content Hierarchy (CRUD factory — in `routes/content/crud.ts`)
`courses`, `semesters`, `sections`, `topics`, `summaries`, `chunks`, `summary-blocks`, `keywords`, `subtopics`

### Content Custom (in `routes/content/`)
`/keyword-connections`, `/kw-prof-notes`, `/reorder`, `/content-tree`

### Student Instruments (CRUD factory — in `routes-student.tsx`)
`flashcards`, `quiz-questions`, `student-notes`, `student-annotations`, `videos`, `highlight-tags`

### Study (CRUD factory — in `routes/study/sessions.ts`)
`study-sessions`, `study-plans`, `study-plan-tasks`

### Study Custom (in `routes/study/`)
`/topic-progress`, `/topics-overview`
`/reviews`, `/quiz-attempts`, `/reading-states`, `/daily-activities`, `/student-stats`, `/fsrs-states`, `/bkt-states`

### Auth & Members (in `routes/members/`)
`/signup`, `/me`, `/institutions`, `/memberships`, `/admin-scopes`

### Billing
`/billing/checkout-session`, `/billing/portal-session`, `/billing/subscription-status`, `/webhooks/stripe`

### Video (Mux — in `routes/mux/`)
`/mux/create-upload`, `/mux/playback-token`, `/mux/track-view`, `/mux/video-stats`, `/mux/asset/:video_id`, `/webhooks/mux`

### Plans & AI Logs (in `routes/plans/`)
`platform-plans`, `institution-plans`, `plan-access-rules`, `institution-subscriptions`, `/ai-generations`, `/summary-diagnostics`, `/content-access`, `/usage-today`

### AI / RAG (in `routes/ai/`)
`/ai/generate`, `/ai/rag-chat`, `/ai/ingest-embeddings`, `/ai/list-models`

### Search (in `routes/search/`)
`/search?q=&type=`, `/trash?type=`, `/restore/:table/:id`

### Storage
`/storage/upload`, `/storage/signed-url`, `/storage/delete`

### 3D Models (CRUD factory)
`models-3d`, `model-3d-pins`, `model-3d-notes`

### Study Queue
`/study-queue` (custom algorithm)
