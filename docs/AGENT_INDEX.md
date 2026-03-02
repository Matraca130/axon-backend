# Agent Quick Index

> **READ THIS FIRST.** This is your navigation map for the axon-backend repo.
> For full details on any section, see [BACKEND_MAP.md](./BACKEND_MAP.md).
> For critical rules, see [AGENT_RULES.md](./AGENT_RULES.md).

---

## "I need to..." Lookup Table

| I need to... | Go to | Notes |
|---|---|---|
| **Add a new CRUD table** | `routes/content/crud.ts` or `routes/study/sessions.ts` | Use `registerCrud()` from `crud-factory.ts`. Add one config block. Done. |
| **Add a custom endpoint for content** | `routes/content/` | Create in the right sub-file or add a new one + mount in `routes/content/index.ts` |
| **Add a custom endpoint for study** | `routes/study/` | Same pattern: right sub-file or new one + mount in `routes/study/index.ts` |
| **Add a new domain** (auth, billing, etc.) | Create `routes-{domain}.ts` at server root | Mount it in `index.ts` |
| **Find how auth works** | `db.ts` | `authenticate(c)` returns `{ user, db }`. See dual-header pattern below |
| **Find how CRUD factory works** | `crud-factory.ts` | Generates LIST/GET/POST/PUT/DELETE from one config object |
| **Add validation** | `validate.ts` | Type guards + `validateFields()` for declarative batch validation |
| **Find an endpoint** | Search table below or `BACKEND_MAP.md` | All routes are flat: `/things?parent_id=xxx` |
| **Add a DB migration** | `supabase/migrations/` | Name: `YYYYMMDD_NN_description.sql`. Mark status in BACKEND_MAP.md |
| **Add a test** | `supabase/functions/server/tests/` | Deno-native: `Deno.test()` + `std/assert`. Name: `thing_test.ts` |
| **Check env vars** | `BACKEND_MAP.md` > Environment Variables | Or grep for `Deno.env.get` |
| **Understand the Mux video system** | `routes-mux.ts` | Upload via @mux/upchunk, playback via signed JWTs |
| **Understand Stripe billing** | `routes-billing.tsx` | Checkout, portal, webhooks (timing-safe + idempotent) |
| **Understand the study algorithm** | `routes-study-queue.tsx` | Custom spaced repetition queue builder |

---

## File Structure at a Glance

```
supabase/functions/server/
├─ index.ts              ← ENTRYPOINT (mounts everything)
├─ db.ts                 ← Auth + Supabase clients + response helpers
├─ crud-factory.ts       ← Generic CRUD generator
├─ validate.ts           ← Type guards + field validation
├─ rate-limit.ts         ← 120 req/min sliding window
├─ timing-safe.ts        ← Constant-time comparison
│
├─ routes/content/       ← Content hierarchy (10 CRUD + 4 custom groups)
├─ routes/study/         ← Study system (3 CRUD + 4 custom groups)
│
├─ routes-auth.tsx       ← signup, /me
├─ routes-billing.tsx    ← Stripe checkout/portal/webhooks
├─ routes-members.tsx    ← Institutions + memberships + scopes
├─ routes-models.tsx     ← 3D models (tiny, 3 CRUDs)
├─ routes-mux.ts         ← Mux video upload/playback/tracking
├─ routes-plans.tsx      ← Plans + AI generation logs + diagnostics
├─ routes-search.ts      ← Global search + trash + restore
├─ routes-storage.tsx    ← File upload/download (Supabase Storage)
├─ routes-student.tsx    ← Flashcards, quizzes, notes, videos
└─ routes-study-queue.tsx ← Study queue algorithm
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

1. **Creating nested routes** → They will 404. Use `?parent_key=value`
2. **Forgetting to mount in index.ts** → New route files need `app.route("/", newRoutes)`
3. **Forgetting to mount in module index** → New sub-files in `routes/content/` or `routes/study/` need mounting in their `index.ts`
4. **Using admin client for user operations** → Use `auth.db` (user-scoped). Only use `getAdminClient()` for admin-only ops
5. **Hardcoding Figma Make URLs** → Production URL is `https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/server`
6. **Adding YouTube/Vimeo video code** → Video is Mux-only. No URL fields, no platform selectors, no iframes

---

## Quick Endpoint Finder

### Content Hierarchy (CRUD factory)
`courses`, `semesters`, `sections`, `topics`, `summaries`, `chunks`, `summary-blocks`, `keywords`, `subtopics`

### Content Custom
`/keyword-connections`, `/kw-prof-notes`, `/reorder`, `/content-tree`

### Student Instruments (CRUD factory)
`flashcards`, `quiz-questions`, `student-notes`, `student-annotations`, `videos`, `highlight-tags`

### Study (CRUD factory)
`study-sessions`, `study-plans`, `study-plan-tasks`

### Study Custom
`/reviews`, `/quiz-attempts`, `/reading-states`, `/daily-activities`, `/student-stats`, `/fsrs-states`, `/bkt-states`

### Auth & Members
`/signup`, `/me`, `/institutions`, `/memberships`, `/admin-scopes`

### Billing
`/billing/checkout-session`, `/billing/portal-session`, `/billing/subscription-status`, `/webhooks/stripe`

### Video (Mux)
`/mux/create-upload`, `/mux/playback-token`, `/mux/track-view`, `/mux/video-stats`, `/mux/asset/:video_id`, `/webhooks/mux`

### Plans & AI
`platform-plans`, `institution-plans`, `plan-access-rules`, `institution-subscriptions`, `/ai-generations`, `/summary-diagnostics`, `/content-access`, `/usage-today`

### Search
`/search?q=&type=`, `/trash?type=`, `/restore/:table/:id`

### Storage
`/storage/upload`, `/storage/signed-url`, `/storage/delete`

### 3D Models (CRUD factory)
`models-3d`, `model-3d-pins`, `model-3d-notes`

### Study Queue
`/study-queue` (custom algorithm)
