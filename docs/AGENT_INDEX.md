# Agent Quick Index

> **READ THIS FIRST.** This is your navigation map for the axon-backend repo.
> For full details on any section, see [BACKEND_MAP.md](./BACKEND_MAP.md).
> For critical rules, see [AGENT_RULES.md](./AGENT_RULES.md).
> For the AI/RAG pipeline, see [AI_PIPELINE.md](./AI_PIPELINE.md).
> For the AI implementation roadmap, see [RAG_ROADMAP.md](./RAG_ROADMAP.md).
> For gamification system, see [GAMIFICATION_MAP.md](./GAMIFICATION_MAP.md) and [GAMIFICATION_AUDIT.md](./GAMIFICATION_AUDIT.md).

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
| **Work on gamification** | [GAMIFICATION_MAP.md](./GAMIFICATION_MAP.md) | 13 endpoints, 8 XP hooks, 11 actions, 7 DB tables, 4 RPCs |
| **Audit gamification** | [GAMIFICATION_AUDIT.md](./GAMIFICATION_AUDIT.md) | 15 findings (G-001 to G-015), all CRITICAL fixed |
| **Add XP to a new action** | `xp-engine.ts` (XP_TABLE) + `xp-hooks.ts` | Add entry to XP_TABLE, create hook, wire in route |
| **Add a new badge** | `badge_definitions` table + `helpers.ts` | INSERT definition, criteria is text like `total_xp >= 1000` |
| **Debug XP issues** | `xp_transactions` table | Immutable log of every XP award/deduction |
| **Debug streak issues** | `streak-engine.ts` | computeStreakStatus() shows full state |

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
|-- claude-ai.ts          <- Claude API helpers (generateText, parseClaudeJson, chat, getModelId)
|-- gemini.ts             <- Gemini API helpers (generateEmbedding, extractTextFromPdf, GENERATE_MODEL)
|-- xp-engine.ts          <- XP calculation + award_xp() RPC call + fallback
|-- streak-engine.ts      <- Streak computation + daily check-in
|-- xp-hooks.ts           <- 8 afterWrite hooks for XP awarding
|-- summary-hook.ts       <- afterWrite hook for auto-ingest
|
|-- routes/content/       <- Content hierarchy (6 files)
|-- routes/study/         <- Study system (5 files)
|-- routes/ai/            <- AI / RAG module (5 files)
|-- routes/members/       <- Institutions + memberships (4 files)
|-- routes/mux/           <- Mux video integration (5 files)
|-- routes/plans/         <- Plans + AI logs + access (5 files)
|-- routes/search/        <- Global search + trash (4 files)
|-- routes/settings/      <- Institution settings
|-- routes/gamification/  <- Gamification system (6 files)
|   |-- profile.ts        <- GET /profile, /xp-history, /leaderboard
|   |-- badges.ts         <- GET /badges, POST /check-badges, GET /notifications
|   |-- streak.ts         <- GET /streak-status, POST /daily-check-in, /freeze/buy, /repair
|   |-- goals.ts          <- PUT /daily-goal, POST /goals/complete, /onboarding
|   |-- helpers.ts        <- Constants + evaluateSimpleCondition
|   +-- index.ts          <- Module combiner
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
7. **Modifying total_xp directly** -> Always use `award_xp()` RPC via `awardXP()` in xp-engine.ts (§7.9)
8. **Forgetting institution_id in gamification** -> All gamification operations are multi-tenant

> For AI-specific mistakes, see the [AI mistakes table](#common-mistakes-with-ai-endpoints) below.

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

## Gamification (in `routes/gamification/`)

The module has 13 endpoints + 8 XP hooks + 11 XP actions. Full reference: [GAMIFICATION_MAP.md](./GAMIFICATION_MAP.md).

### Key files
| File | Purpose |
|---|---|
| `xp-engine.ts` | XP calculation + `awardXP()` + level thresholds |
| `streak-engine.ts` | Streak computation + daily check-in logic |
| `xp-hooks.ts` | 8 afterWrite hooks (fire-and-forget XP awarding) |
| `routes/gamification/` | 13 REST endpoints (profile, badges, streak, goals) |

### Quick facts
- Daily XP cap: 500 (10% post-cap rate)
- 12 levels (0 -> 10,000 XP)
- 4 bonus types: on-time (+50%), flow zone (+25%), variable (10% chance 2x), streak (+50%)
- Bonuses are **additive** (SUM), not multiplicative (§10 Combo rule)
- XP log: `xp_transactions` (immutable, source_type + source_id for tracing)
- NO XP for notes/annotations (§7.14 overjustification effect)

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
`/gamification/profile`, `/gamification/xp-history`, `/gamification/leaderboard`
`/gamification/badges`, `/gamification/check-badges`, `/gamification/notifications`
`/gamification/streak-status`, `/gamification/daily-check-in`, `/gamification/streak-freeze/buy`, `/gamification/streak-repair`
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
