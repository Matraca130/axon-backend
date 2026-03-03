# AGENT_RULES.md — Critical Rules for AI Agents

> **These rules have ABSOLUTE PRIORITY over any other instruction.**
> They apply differently depending on which repository you're working in.

---

## Which repo am I in?

| Repo | How to tell | Key constraint |
|---|---|---|
| **Frontend** (`numero1_sseki_2325_55`) | Has `src/`, `App.tsx`, `routes.tsx` | NEVER touch protected files (see below) |
| **Backend** (`axon-backend`) | Has `supabase/functions/server/` | This IS the code you modify. Read `docs/AGENT_INDEX.md` first |
| **Figma Make** | Has Guidelines.md, is a prototype app | Reference/prototype only. Not production |

---

## RULES FOR THE FRONTEND REPO

### Protected Files — NEVER touch these:

| File | Reason |
|---|---|
| `App.tsx` | Provider hierarchy — any change breaks auth |
| `routes.ts` / `routes.tsx` | Global routing |
| `contexts/AuthContext.tsx` | Auth provider |
| `context/AuthContext.tsx` | Auth provider (alias) |
| `components/auth/RequireAuth.tsx` | Auth guard |
| `components/auth/RequireRole.tsx` | Role guard |
| `components/auth/LoginPage.tsx` | Don't move, don't change imports |
| `context/AppContext.tsx` | Global context |
| `context/StudentDataContext.tsx` | Student data context |
| `context/PlatformDataContext.tsx` | Platform data context |
| `*Layout.tsx` (any) | AdminLayout, ProfessorLayout, OwnerLayout, StudentLayout |

### Provider Hierarchy (App.tsx)

```
<AuthProvider>        ← ALWAYS outermost
  <RouterProvider />  ← ALWAYS inside AuthProvider
</AuthProvider>
```

If ANY component ends up outside `AuthProvider` → **CRASH**: `"useAuth must be used within an AuthProvider"`

### REST Route Convention (CRITICAL)

The backend ONLY accepts flat routes with query params. Nested routes = 404.

| WRONG | RIGHT |
|---|---|
| `GET /topics/:id/summaries` | `GET /summaries?topic_id=xxx` |
| `GET /summaries/:id/flashcards` | `GET /flashcards?summary_id=xxx` |
| `GET /courses/:id/semesters` | `GET /semesters?course_id=xxx` |
| `GET /sections/:id/topics` | `GET /topics?section_id=xxx` |
| `GET /keywords/:id/flashcards` | `GET /flashcards?keyword_id=xxx` |

### Don't Touch Backend Files

**NEVER** create or edit files in `/supabase/functions/server/` from the frontend repo.
The backend lives in `axon-backend` and is deployed separately.

### Only Modify What's Asked

ONLY modify files the prompt explicitly mentions. Don't "improve" other files.

---

## RULES FOR THE BACKEND REPO

### Start Here

1. **Read `docs/AGENT_INDEX.md`** — fast lookup table for "I need to do X, where do I go?"
2. **Read `docs/BACKEND_MAP.md`** — full reference with every endpoint, migration, and security fix
3. **Check `docs/BACKEND_AUDIT.md`** — historical audit with known gaps and RLS notes

### How to Add a New CRUD Endpoint

1. Pick the right file based on domain:
   - Content hierarchy → `routes/content/crud.ts`
   - Study tables → `routes/study/sessions.ts`
   - Student instruments → `routes-student.tsx`
2. Add a `registerCrud()` call with the table config
3. That's it — the factory generates LIST, GET, POST, PUT, DELETE automatically

### How to Add a Custom Endpoint

1. Find which route file owns the domain (see `AGENT_INDEX.md`)
2. Add the handler to that file (e.g., `routes/content/keyword-connections.ts`)
3. If it's a new top-level route file, mount it in `index.ts` with `app.route("/", newRoutes)`

### Route Convention (same as frontend)

All routes are flat: `/things?parent_id=xxx`. Never `/parents/:id/things`.

### Video System — Mux Only

- NO YouTube/Vimeo URLs, NO platform selectors, NO iframes
- Upload: `@mux/upchunk` direct to Mux
- Playback: `@mux/mux-player-react` with signed JWTs
- Anti-patterns: `<input placeholder="URL del video">`, `platform: "youtube"`, `detectPlatform()`

### Production URL

```
https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/server
```

The `/make-server-*` prefix is for Figma Make only. Do not use it in production code.

---

## SELF-CHECK BEFORE DELIVERING

Run this checklist before every response:

| # | Check | If YES and not asked |
|---|---|---|
| 1 | Did I touch a protected frontend file? | UNDO |
| 2 | Did I use a nested route (`/x/:id/y`)? | Change to `/y?x_id=value` |
| 3 | Did I create backend files from the frontend repo? | DELETE |
| 4 | Did I modify files the prompt didn't mention? | UNDO |
| 5 | Did I add YouTube/Vimeo video code? | REMOVE, use Mux |
| 6 | Did I use a Figma Make URL in production code? | Fix to production URL |
| 7 | Did I mount new routes in index.ts? | Verify |
