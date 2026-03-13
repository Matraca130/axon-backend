# Agent Quick Index

> **READ THIS FIRST.** This is your navigation map for the axon-backend repo.
> For full details on any section, see [BACKEND_MAP.md](./BACKEND_MAP.md).
> For critical rules, see [AGENT_RULES.md](./AGENT_RULES.md).
> For the AI/RAG pipeline, see [AI_PIPELINE.md](./AI_PIPELINE.md).
> For the AI implementation roadmap, see [RAG_ROADMAP.md](./RAG_ROADMAP.md).
> For the gamification system, see [GAMIFICATION_MAP.md](./GAMIFICATION_MAP.md) and [GAMIFICATION_AUDIT.md](./GAMIFICATION_AUDIT.md).

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
| **Use AI generation (flashcards/quiz)** | `routes/ai/generate.ts` | POST `/ai/generate` -- needs `action` + `summary_id`. See [AI_PIPELINE.md](./AI_PIPELINE.md) |
| **Use RAG Chat (semantic search + answer)** | `routes/ai/chat.ts` | POST `/ai/rag-chat` -- needs `message` (NOT `question`). See [AI_PIPELINE.md](./AI_PIPELINE.md) |
| **Ingest embeddings for RAG** | `routes/ai/ingest.ts` | POST `/ai/ingest-embeddings` -- needs `institution_id`. Run before RAG Chat works |
| **Change the AI model** | `gemini.ts` | Edit `GENERATE_MODEL` constant. Single source of truth (D-18 fix) |
| **Debug AI/embedding issues** | `routes/ai/list-models.ts` | GET `/ai/list-models` -- shows available models for current API key |
| **Understand the RAG pipeline** | [AI_PIPELINE.md](./AI_PIPELINE.md) | Architecture, security model, RPCs, fix history |
| **See what AI features are pending** | [RAG_ROADMAP.md](./RAG_ROADMAP.md) | 8 phases: chunking, retrieval, re-ranking, adaptive IA, PDF ingest |
| **Implement chunking strategies** | [RAG_ROADMAP.md > Fase 5](./RAG_ROADMAP.md#fase-5--chunking-inteligente--auto-ingest) | Recursive, Semantic, Parent-Child, Agentic. Decision framework included |
| **Implement advanced retrieval** | [RAG_ROADMAP.md > Fase 6](./RAG_ROADMAP.md#fase-6--retrieval-avanzado-multi-query--hyde--re-ranking) | Multi-Query (+25% recall), HyDE (+20%), Re-ranking (+40% precision) |
| **Implement NeedScore in AI generation** | [RAG_ROADMAP.md > Fase 8](./RAG_ROADMAP.md#fase-8--ia-adaptativa-needscore--pre-generacion--calidad) | Smart generation, pre-generation, quality feedback |
| **Understand the adaptive learning system** | [RAG_ROADMAP.md > Fase 8](./RAG_ROADMAP.md#fase-8--ia-adaptativa-needscore--pre-generacion--calidad) | BKT + FSRS + NeedScore integration |
| **Understand the gamification system** | [GAMIFICATION_MAP.md](./GAMIFICATION_MAP.md) | XP engine, streak engine, badges, leaderboard. 13 endpoints |
| **Add XP to a new action** | `xp-engine.ts` + `xp-hooks.ts` | Add to XP_TABLE, create afterWrite hook, wire in the route |
| **Add a new badge** | SQL INSERT into `badge_definitions` | Set `criteria` string (e.g. `"total_xp >= 500"`), `trigger_type: 'auto'` |
| **Debug gamification issues** | [GAMIFICATION_AUDIT.md](./GAMIFICATION_AUDIT.md) | 7 pending code fixes (G-001 to G-007) |
| **Understand streak lifecycle** | `streak-engine.ts` | Check-in, freeze consume, repair eligibility. Pure logic + DB ops |
| **Understand XP hooks** | `xp-hooks.ts` | 8 hooks covering 11 XP actions. Fire-and-forget pattern |

---

## File Structure at a Glance

For the full tree with every file, see [BACKEND_MAP.md > Repository Structure](./BACKEND_MAP.md#repository-structure).

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
|-- xp-engine.ts          <- XP calculation + award_xp() RPC + bonuses + level calc
|-- streak-engine.ts      <- Streak lifecycle (check-in, freeze consume, repair)
|-- xp-hooks.ts           <- 8 afterWrite hooks for XP awards (11 actions)
|
|-- routes/content/       <- Content hierarchy (6 files)
|-- routes/study/         <- Study system (5 files)
|-- routes/ai/            <- AI / RAG module (5 files)
|-- routes/gamification/  <- Gamification system (6 files, 13 endpoints)
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
- `Authorization: Bearer <ANON_KEY>` -- passes Supabase gateway
- `X-Access-Token: <USER_JWT>` -- identifies the user

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
7. **Modifying total_xp directly** -> Always use `award_xp()` RPC (contract S7.9). See G-004 in GAMIFICATION_AUDIT.md
8. **Inserting student_badges without institution_id** -> Required for multi-tenancy. See G-002 in GAMIFICATION_AUDIT.md

> For AI-specific mistakes, see the [AI mistakes table](#common-mistakes-with-ai-endpoints) below.

---

## Gamification (in `routes/gamification/`)

The module has 13 endpoints across 4 sub-routers. See [GAMIFICATION_MAP.md](./GAMIFICATION_MAP.md) for full reference.

### Quick endpoint table

| Method | Path | Description |
|---|---|---|
| GET | `/gamification/profile` | Composite XP + streak + badge count |
| GET | `/gamification/xp-history` | Paginated XP transaction log |
| GET | `/gamification/leaderboard` | Weekly/daily leaderboard |
| GET | `/gamification/badges` | Badge catalog + earned status |
| POST | `/gamification/check-badges` | Evaluate and award eligible badges |
| GET | `/gamification/notifications` | Unified event timeline |
| GET | `/gamification/streak-status` | Streak info + repair eligibility |
| POST | `/gamification/daily-check-in` | Daily streak check-in |
| POST | `/gamification/streak-freeze/buy` | Buy streak freeze with XP |
| POST | `/gamification/streak-repair` | Repair broken streak with XP |
| PUT | `/gamification/daily-goal` | Update daily XP goal |
| POST | `/gamification/goals/complete` | Complete goal + bonus XP |
| POST | `/gamification/onboarding` | Init gamification profile |

### Common mistakes with gamification

| WRONG | RIGHT | Why |
|---|---|---|
| Direct UPDATE on `student_xp.total_xp` | Use `award_xp()` RPC | Contract S7.9. Bypasses cap + level calc |
| INSERT `student_badges` without `institution_id` | Always include `institution_id` | Multi-tenancy (G-002) |
| INSERT `streak_freezes` without `freeze_type` | Include `freeze_type: 'purchased'` | Column has CHECK constraint (G-001) |
| Checking `icon_url` on badge_definitions | Column is `icon` (TEXT) | G-005: PostgREST returns null silently |

---

## AI / RAG (in `routes/ai/`)

The module has 4 endpoints: `/ai/generate`, `/ai/ingest-embeddings`, `/ai/rag-chat`, `/ai/list-models`.

For the full endpoint table with methods, descriptions, and file mapping, see [BACKEND_MAP.md > routes/ai/](./BACKEND_MAP.md#routesai--ai--rag-module-5-files).
For exact payloads and response examples, see [figma-make/06-ai-rag.md](./figma-make/06-ai-rag.md).
For pending features and implementation plan, see [RAG_ROADMAP.md](./RAG_ROADMAP.md).

### Common mistakes with AI endpoints

| WRONG | RIGHT | Why |
|---|---|---|
| `{ "question": "..." }` in rag-chat | `{ "message": "..." }` | Field is `message`, not `question` |
| Calling `/ai/generate` without `action` | `{ "action": "flashcard", "summary_id": "..." }` | `action` is required |
| Calling `/ai/generate` without `summary_id` | Always include `summary_id` | Required for content context |
| Hardcoding model name in `_meta` | Import `GENERATE_MODEL` from `gemini.ts` | Single source of truth (D-18) |
| Calling Gemini before DB query | DB query first, then Gemini | Security (PF-05). See [AI_PIPELINE.md](./AI_PIPELINE.md#security-model) |

---

## Quick Endpoint Finder

### Content Hierarchy (CRUD factory -- in `routes/content/crud.ts`)
`courses`, `semesters`, `sections`, `topics`, `summaries`, `chunks`, `summary-blocks`, `keywords`, `subtopics`

### Content Custom (in `routes/content/`)
`/keyword-connections`, `/kw-prof-notes`, `/reorder`, `/content-tree`

### Student Instruments (CRUD factory -- in `routes-student.tsx`)
`flashcards`, `quiz-questions`, `quizzes`, `student-notes`, `student-annotations`, `videos`, `highlight-tags`

### Study (CRUD factory -- in `routes/study/sessions.ts`)
`study-sessions`, `study-plans`, `study-plan-tasks`

### Study Custom (in `routes/study/`)
`/topic-progress`, `/topics-overview`
`/reviews`, `/quiz-attempts`, `/reading-states`, `/daily-activities`, `/student-stats`, `/fsrs-states`, `/bkt-states`

### Gamification (in `routes/gamification/`)
`/gamification/profile`, `/gamification/xp-history`, `/gamification/leaderboard`,
`/gamification/badges`, `/gamification/check-badges`, `/gamification/notifications`,
`/gamification/streak-status`, `/gamification/daily-check-in`, `/gamification/streak-freeze/buy`, `/gamification/streak-repair`,
`/gamification/daily-goal`, `/gamification/goals/complete`, `/gamification/onboarding`

### Auth (in `routes-auth.tsx`)
`/signup`, `/me` (GET/PUT)

### Members (in `routes/members/`)
`/institutions`, `/memberships`, `/admin-scopes`

### Billing (in `routes-billing.tsx`)
`/billing/checkout-session`, `/billing/portal-session`, `/billing/subscription-status`, `/webhooks/stripe`

### Video (Mux -- in `routes/mux/`)
`/mux/create-upload`, `/mux/playback-token`, `/mux/track-view`, `/mux/video-stats`, `/mux/asset/:video_id`, `/webhooks/mux`

### Plans & AI Logs (in `routes/plans/`)
`platform-plans`, `institution-plans`, `plan-access-rules`, `institution-subscriptions`, `/ai-generations`, `/summary-diagnostics`, `/content-access`, `/usage-today`

### AI / RAG (in `routes/ai/`)
`/ai/generate`, `/ai/rag-chat`, `/ai/ingest-embeddings`, `/ai/list-models`

### Search (in `routes/search/`)
`/search?q=&type=`, `/trash?type=`, `/restore/:table/:id`

### Storage (in `routes-storage.tsx`)
`/storage/upload`, `/storage/signed-url`, `/storage/delete`

### 3D Models (CRUD factory -- in `routes-models.tsx`)
`models-3d`, `model-3d-pins`, `model-3d-notes`

### Study Queue (in `routes-study-queue.tsx`)
`/study-queue` (custom algorithm)
