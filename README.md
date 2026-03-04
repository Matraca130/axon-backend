# Axon v4.4 — Educational Platform Backend

Hono web server on Supabase Edge Functions (Deno). 176 HTTP routes across 39 PostgreSQL tables, with AI/RAG capabilities powered by Gemini.

## For AI Agents

If you're an AI agent working on this codebase, start here:

1. **[`docs/AGENT_INDEX.md`](docs/AGENT_INDEX.md)** — Fast lookup table: "I need to do X, where do I go?"
2. **[`docs/AGENT_RULES.md`](docs/AGENT_RULES.md)** — Critical rules (protected files, route conventions, anti-patterns)
3. **[`docs/AI_PIPELINE.md`](docs/AI_PIPELINE.md)** — AI/RAG architecture, models, security, payloads
4. **[`docs/BACKEND_MAP.md`](docs/BACKEND_MAP.md)** — Full reference with every endpoint, migration, and security fix

## Architecture

```
Frontend (React) --> Supabase Gateway --> Hono Edge Function --> PostgreSQL (RLS)
                                                            --> Gemini API (AI/RAG)
```

- **Runtime:** Deno (Supabase Edge Functions)
- **Framework:** Hono
- **Database:** Supabase PostgreSQL with Row Level Security
- **Auth:** Supabase Auth (JWT) with dual-header pattern
- **AI:** Gemini 2.5 Flash (generation) + gemini-embedding-001 (embeddings, 768 dims)
- **CI/CD:** GitHub Actions auto-deploys to Supabase on push to `main`

## Backend Files

| File | Purpose |
|---|---|
| `index.ts` | Entrypoint. Mounts all route modules, CORS, logger, health check |
| `db.ts` | Supabase clients (admin/user), JWT auth, response helpers |
| `crud-factory.ts` | Generic CRUD route generator (LIST/GET/POST/PUT/DELETE/RESTORE) |
| `validate.ts` | Runtime validation guards (UUID, email, ranges, probabilities) |
| `gemini.ts` | Gemini API helpers: `generateText()`, `generateEmbedding()`, `GENERATE_MODEL` constant |
| `auth-helpers.ts` | Role-based access control: `requireInstitutionRole()`, role constants |
| `rate-limit.ts` | In-memory sliding window rate limiter (120 req/min) |
| `timing-safe.ts` | Constant-time string comparison for webhook signatures |
| `routes-auth.tsx` | Signup, profile (GET/PUT /me) |
| `routes/content/` | Content hierarchy: courses, semesters, sections, topics, summaries, chunks, keywords, subtopics, keyword connections, professor notes, reorder, content-tree |
| `routes-student.tsx` | Learning instruments (flashcards, quiz questions, videos) + student notes |
| `routes/study/` | Study sessions, reviews, quiz attempts, reading states, daily activities, student stats, FSRS states, BKT states, study plans |
| `routes/ai/` | **AI/RAG module:** generate flashcards/quiz, ingest embeddings, RAG chat, list models |
| `routes-models.tsx` | 3D models, pins, student model notes |
| `routes/plans/` | Platform plans, institution plans, access rules, subscriptions, AI generation logs |
| `routes-billing.tsx` | Stripe checkout, portal, webhooks |
| `routes/mux/` | Mux video upload, playback, tracking, webhooks |
| `routes/search/` | Global search, trash, restore |
| `routes-storage.tsx` | File upload/download/delete |

## Connection

**Production:**
```
https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/server
```

**Figma Make (prototyping only):**
```
https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/make-server-6569f786
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

## AI / RAG Pipeline

```
Summary content_markdown -> Chunks -> Embeddings (768-dim vectors)
                                         |
 User question -> Embed query -> Hybrid search (pgvector + full-text)
                                         |
                              RAG context + Student profile -> Gemini -> Response
```

See [`docs/AI_PIPELINE.md`](docs/AI_PIPELINE.md) for full details.

## Roles

| Role | Can do |
|---|---|
| **Student** | Read content, study, take personal notes, spaced repetition |
| **Professor** | Create/edit content (summaries, flashcards, quizzes, etc.) |
| **Owner** | Manage institution, memberships, plans |

## Figma Make Integration

The `docs/figma-make/` directory contains **copy-paste blocks** designed for Figma Make sessions. Each block is self-contained and includes the full API reference for a specific area.

See [`docs/figma-make/README.md`](docs/figma-make/README.md) for usage instructions.
