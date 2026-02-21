# Axon v4.4 — Educational Platform Backend

Hono web server on Supabase Edge Functions (Deno). 176 HTTP routes across 39 PostgreSQL tables.

## Architecture

```
Frontend (React) --> Supabase Gateway --> Hono Edge Function --> PostgreSQL (RLS)
```

- **Runtime:** Deno (Supabase Edge Functions)
- **Framework:** Hono
- **Database:** Supabase PostgreSQL with Row Level Security
- **Auth:** Supabase Auth (JWT) with dual-header pattern

## Backend Files

| File | Purpose |
|---|---|
| `index.tsx` | Entrypoint. Mounts all route modules, CORS, logger, health check |
| `db.ts` | Supabase clients (admin/user), JWT auth, response helpers |
| `crud-factory.ts` | Generic CRUD route generator (LIST/GET/POST/PUT/DELETE/RESTORE) |
| `validate.ts` | Runtime validation guards (UUID, email, ranges, probabilities) |
| `routes-auth.tsx` | Signup, profile (GET/PUT /me) |
| `routes-content.tsx` | Content hierarchy: courses, semesters, sections, topics, summaries, chunks, keywords, subtopics, keyword connections, professor notes, reorder, content-tree |
| `routes-student.tsx` | Learning instruments (flashcards, quiz questions, videos) + student notes (keyword notes, text annotations, video notes) |
| `routes-study.tsx` | Study sessions, reviews, quiz attempts, reading states, daily activities, student stats, FSRS states, BKT states, study plans |
| `routes-models.tsx` | 3D models, pins, student model notes |
| `routes-plans.tsx` | Platform plans, institution plans, access rules, subscriptions, AI generation logs, summary diagnostics |

## Connection

```
Base URL: https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/make-server-6569f786
```

### Headers

| Header | Value | When |
|---|---|---|
| `Authorization` | `Bearer {publicAnonKey}` | Always (Supabase gateway) |
| `X-Access-Token` | `{userJWT}` | All authenticated routes |

### Response Patterns

- **Success:** `{ "data": ... }`
- **Error:** `{ "error": "descriptive message" }`
- **Paginated lists** (factory CRUD): `{ "data": { "items": [...], "total": N, "limit": N, "offset": N } }`
- **Custom lists** (flat array): `{ "data": [...] }`
- **Single object or null:** `{ "data": { ... } }` or `{ "data": null }`

## Data Hierarchy

```
Institution -> Course -> Semester -> Section -> Topic -> Summary
  Summary -> Chunks, Keywords, Flashcards, Quiz Questions, Videos
  Keywords -> Subtopics, Keyword Connections, Prof Notes, Student Notes
  Topic -> 3D Models -> Pins, Student Model Notes
```

## Roles

| Role | Can do |
|---|---|
| **Student** | Read content, study, take personal notes, spaced repetition |
| **Professor** | Create/edit content (summaries, flashcards, quizzes, etc.) |
| **Owner** | Manage institution, memberships, plans |

## Figma Make Integration

The `docs/figma-make/` directory contains **copy-paste blocks** designed for Figma Make sessions. Each block is self-contained and includes the full API reference for a specific area.

See [`docs/figma-make/README.md`](docs/figma-make/README.md) for usage instructions.
