# Axon E2E Test Suite

End-to-end integration tests for the Axon backend API. These tests exercise the
real Supabase Edge Functions deployment via HTTP, covering authentication,
content CRUD, learning flows, gamification, RBAC security, and edge-case
robustness.

## Quick Start

### Environment Variables (required)

| Variable | Description |
|---|---|
| `TEST_SUPABASE_URL` | Supabase project URL (e.g. `https://xxx.supabase.co`) |
| `TEST_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `TEST_ADMIN_EMAIL` | Owner/admin account email |
| `TEST_ADMIN_PASSWORD` | Owner/admin account password |
| `TEST_INSTITUTION_ID` | UUID of the test institution |
| `TEST_USER_EMAIL` | Student account email (optional, enables RBAC tests) |
| `TEST_USER_PASSWORD` | Student account password (optional) |

### Run Commands

```bash
# Full suite
export PATH="$HOME/.deno/bin:$PATH"
deno test tests/e2e/ --allow-net --allow-env --no-check

# Single file
deno test tests/e2e/00-smoke.test.ts --allow-net --allow-env --no-check

# With env file (if using .env)
export $(cat .env.test | xargs) && deno test tests/e2e/ --allow-net --allow-env --no-check
```

When credentials are not set, tests are **ignored** (not failed) via the
`ignore: !HAS_CREDS` pattern. This means the suite always passes in CI even
without secrets configured.

---

## Test Files (10 files, 169 tests)

### 00-smoke.test.ts -- Smoke Tests (3 tests)

Quick health check to verify the API is reachable and auth works.

| ID | Endpoint | Description |
|---|---|---|
| SMOKE-01 | `GET /health` | Health check returns 200 with `status: "ok"` |
| SMOKE-02 | `POST /auth/v1/token` | Login returns valid `access_token` |
| SMOKE-03 | `GET /me` | Authenticated profile returns user data |

### 01-auth-flow.test.ts -- Auth & Profile (5 tests)

Full authentication lifecycle including JWT validation and profile update.

| ID | Endpoint | Description |
|---|---|---|
| AUTH-01 | `POST /auth/v1/token` | Valid login returns JWT with 3 parts |
| AUTH-02 | `POST /auth/v1/token` | Wrong password returns 400 |
| AUTH-03 | `GET /me` | Profile matches login email |
| AUTH-04 | `PUT /me` | Update full_name, verify persistence, restore |
| AUTH-05 | `GET /institutions` | Returns user institution memberships |

### 02-owner-institution.test.ts -- Institution Management (13 tests)

Owner CRUD for institutions, memberships, and plans.

| ID | Endpoint | Description |
|---|---|---|
| INST-01 | `GET /institutions` | List owner's institutions |
| INST-02 | `GET /institutions/:id` | Single institution detail |
| INST-03 | `PUT /institutions/:id` | Update institution name + restore |
| INST-04 | `GET /memberships` | List institution members (paginated) |
| INST-05 | `POST /memberships` | Add new member |
| INST-06 | `PUT /memberships/:id` | Change member role |
| INST-07 | `PUT /memberships/:id` | Deactivate member (is_active=false) |
| INST-08 | `DELETE /memberships/:id` | Soft-delete membership |
| INST-09 | `GET /institution-plans` | List plans |
| INST-10 | `POST /institution-plans` | Create plan |
| INST-11 | `PUT /institution-plans/:id` | Update plan |
| INST-12 | `DELETE /institution-plans/:id` | Delete plan |
| INST-13 | -- | TODO: `/admin/students/:id` not implemented |

### 03-professor-content.test.ts -- Content Tree CRUD (15 tests)

Full content hierarchy: course -> semester -> section -> topic -> summary -> keyword.

| ID | Endpoint | Description |
|---|---|---|
| CONTENT-00 | login | Authenticate for content tests |
| CONTENT-01 | `POST /courses` | Create course |
| CONTENT-02 | `GET /courses` | Verify course in list |
| CONTENT-03 | `POST /semesters` | Create semester |
| CONTENT-04 | `GET /semesters` | Verify semester in list |
| CONTENT-05 | `POST /sections` | Create section |
| CONTENT-06 | `GET /sections` | Verify section in list |
| CONTENT-07 | `POST /topics` | Create topic |
| CONTENT-08 | `GET /topics` | Verify topic in list |
| CONTENT-09 | `POST /summaries` | Create summary |
| CONTENT-10 | `GET /summaries` | Verify summary in list |
| CONTENT-11 | `POST /keywords` | Create keyword |
| CONTENT-12 | `GET /keywords` | Verify keyword in list |
| CONTENT-13 | `GET /content-tree` | Full nested tree |
| CONTENT-14 | cleanup | Delete all in reverse order |

### 04-professor-instruments.test.ts -- Quiz & Flashcard CRUD (16 tests)

CRUD for quiz-questions and flashcards on top of content hierarchy.

| ID | Endpoint | Description |
|---|---|---|
| INSTR-00 | login | Authenticate |
| INSTR-01..06 | POST content | Create prerequisite hierarchy |
| INSTR-07 | `POST /quiz-questions` | Create quiz question |
| INSTR-08 | `GET /quiz-questions` | Verify question in list |
| INSTR-09 | `PUT /quiz-questions/:id` | Update question text |
| INSTR-10 | `POST /flashcards` | Create flashcard |
| INSTR-11 | `GET /flashcards` | Verify flashcard in list |
| INSTR-12 | `PUT /flashcards/:id` | Update flashcard front |
| INSTR-13 | `DELETE /quiz-questions/:id` | Soft-delete question |
| INSTR-14 | `DELETE /flashcards/:id` | Soft-delete flashcard |
| INSTR-15 | cleanup | Delete prerequisites |

### 05-student-learning-loop.test.ts -- Learning Flow (23 tests)

Core learning loop: content creation, study queue, quiz attempts, flashcard
reviews, FSRS/BKT state, study sessions, daily activities, topic progress.

| ID | Endpoint | Description |
|---|---|---|
| LEARN-00 | login | Admin + student auth |
| LEARN-01..06 | POST content | Create prerequisite hierarchy |
| LEARN-07 | `POST /quiz-questions` | Create quiz question |
| LEARN-08 | `POST /flashcards` | Create flashcard |
| LEARN-09 | `GET /study-queue` | Fetch study queue |
| LEARN-10 | `GET /quiz-questions` | Load quiz for summary |
| LEARN-11 | `POST /quiz-attempts` | Record quiz attempt |
| LEARN-12 | `POST /study-sessions` | Start study session |
| LEARN-13 | `POST /reviews` | Register flashcard review |
| LEARN-14 | `POST /fsrs-states` | Upsert FSRS state |
| LEARN-15 | `GET /fsrs-states` | Verify FSRS interval |
| LEARN-16 | `POST /bkt-states` | Upsert BKT state |
| LEARN-17 | `GET /bkt-states` | Verify BKT p_know |
| LEARN-18 | `PUT /study-sessions/:id` | Close session |
| LEARN-19 | `POST /daily-activities` | Record daily activity |
| LEARN-20 | `GET /daily-activities` | Verify daily activity |
| LEARN-21 | `GET /topic-progress` | Verify topic progress |
| LEARN-22 | cleanup | Delete all content |

### 06-student-gamification.test.ts -- Gamification System (14 tests)

Full gamification flow: onboarding, XP, streaks, badges, leaderboard, goals.

| ID | Endpoint | Description |
|---|---|---|
| GAM-00 | login | Authenticate as student |
| GAM-01 | `POST /gamification/onboarding` | Ensure profile exists |
| GAM-02 | `GET /gamification/profile` | Initial XP and streak |
| GAM-03 | `POST /gamification/daily-check-in` | Daily check-in |
| GAM-04 | `GET /gamification/streak-status` | Streak data |
| GAM-05 | `GET /gamification/xp-history` | XP transactions |
| GAM-06 | `GET /gamification/profile` | XP after check-in |
| GAM-07 | `GET /gamification/badges` | Badge definitions |
| GAM-08 | `POST /gamification/check-badges` | Trigger badge eval |
| GAM-09 | `GET /gamification/leaderboard` | Weekly leaderboard |
| GAM-10 | `GET /gamification/leaderboard` | Daily leaderboard |
| GAM-11 | `GET /gamification/notifications` | Notification feed |
| GAM-12 | `PUT /gamification/daily-goal` | Set daily goal |
| GAM-13 | `POST /gamification/goals/complete` | Complete goal |

### 07-content-lifecycle.test.ts -- CRUD Lifecycle with Soft-Delete (51 tests)

For each of 8 entity types: create, update, soft-delete, verify hidden, verify
visible with `include_deleted=true`, restore. Plus prerequisite setup and cleanup.

Entities tested: courses, semesters, sections, topics, summaries, keywords,
flashcards, quiz-questions.

| ID Range | Entity | Tests |
|---|---|---|
| LIFE-00, 00a | Setup | Login + prerequisite hierarchy |
| LIFE-01..06 | Courses | Create, update, delete, hidden, include_deleted, restore |
| LIFE-07..12 | Semesters | Same lifecycle pattern |
| LIFE-13..18 | Sections | Same lifecycle pattern |
| LIFE-19..24 | Topics | Same lifecycle pattern |
| LIFE-25..30 | Summaries | Same lifecycle pattern |
| LIFE-31..36 | Keywords | Same lifecycle pattern |
| LIFE-37..42 | Flashcards | Same lifecycle pattern |
| LIFE-43..48 | Quiz-Questions | Same lifecycle pattern |
| LIFE-99 | Cleanup | Final cleanup |

### 08-security-rbac.test.ts -- RBAC & Security (14 tests)

Cross-role authorization tests verifying students cannot perform writes,
non-owners cannot delete institutions, unauthenticated requests get 401, and
cross-institution access is denied.

| ID | Scenario | Description |
|---|---|---|
| RBAC-01 | Student POST /courses | 403 (CONTENT_WRITE_ROLES) |
| RBAC-02 | Student POST /summaries | 403 |
| RBAC-03 | Student POST /quiz-questions | 403 |
| RBAC-04 | Student POST /memberships | 403 (MANAGEMENT_ROLES) |
| RBAC-05 | Student PUT /memberships | 403 (role escalation) |
| RBAC-06 | Student DELETE /institutions | 403 (owner only) |
| RBAC-07 | Non-owner DELETE /institutions | 403 |
| RBAC-08 | Student PUT /memberships role | 403 |
| RBAC-09 | No auth token | 401 on 4 protected endpoints |
| RBAC-10 | Invalid/expired JWT | 401 |
| RBAC-11 | Cross-institution access | 403/404 |
| RBAC-12 | Student POST /institution-plans | 403 |
| RBAC-13 | Student PUT /institutions | 403 |
| RBAC-14 | Student POST /flashcards | 403 |

### 09-edge-cases.test.ts -- Edge Cases & Robustness (13 tests)

Verifies graceful error handling for malformed/unusual input.

| ID | Scenario | Description |
|---|---|---|
| EDGE-01a/b/c | Invalid UUID in path | 400/404, not 500 |
| EDGE-02a/b | Empty body on POST | 400 with error message |
| EDGE-03 | ~1MB payload | No 500 crash |
| EDGE-04 | limit=0 | Defaults to 100 |
| EDGE-05 | limit=99999 | Capped at 500 |
| EDGE-06 | Double DELETE | Idempotent, not 500 |
| EDGE-07a/b | SQL injection + special chars | No crash, no injection |
| EDGE-08 | Non-existent UUID | 404 |
| EDGE-09 | Extra unknown fields | Silently ignored |
| EDGE-10a/b | 5 concurrent requests | No race crash |

---

## Shared Helpers

| File | Purpose |
|---|---|
| `tests/helpers/test-client.ts` | `login()`, `api.get/post/put/delete`, `assertStatus`, `assertOk`, `assertError`, `ENV` config |
| `tests/e2e/fixtures/test-data-factory.ts` | `TestData.course()`, `.semester()`, `.section()`, etc. with unique timestamps |
| `tests/e2e/helpers/cleanup.ts` | `track()`, `cleanupAll()`, `resetTracking()` for LIFO entity cleanup |

---

## Endpoint Coverage

### Covered by E2E tests (47 unique endpoints)

| Method | Endpoint | Test File(s) |
|---|---|---|
| GET | `/health` | 00 |
| POST | `/auth/v1/token` (Supabase Auth) | 00, 01 |
| GET | `/me` | 00, 01 |
| PUT | `/me` | 01 |
| GET | `/institutions` | 01, 02 |
| GET | `/institutions/:id` | 02 |
| PUT | `/institutions/:id` | 02, 08 |
| DELETE | `/institutions/:id` | 08 |
| GET | `/memberships` | 02, 08 |
| POST | `/memberships` | 02, 08 |
| PUT | `/memberships/:id` | 02, 08 |
| DELETE | `/memberships/:id` | 02 |
| GET | `/institution-plans` | 02 |
| POST | `/institution-plans` | 02, 08 |
| PUT | `/institution-plans/:id` | 02 |
| DELETE | `/institution-plans/:id` | 02 |
| GET | `/courses` | 03, 07 |
| GET | `/courses/:id` | 03 |
| POST | `/courses` | 03, 04, 05, 07, 08, 09 |
| PUT | `/courses/:id` | 07, 09 |
| DELETE | `/courses/:id` | 07, 09 |
| PUT | `/courses/:id/restore` | 07 |
| GET | `/semesters` | 03, 07 |
| POST | `/semesters` | 03, 04, 05, 07 |
| PUT | `/semesters/:id` | 07 |
| DELETE | `/semesters/:id` | 07 |
| PUT | `/semesters/:id/restore` | 07 |
| GET | `/sections` | 03, 07 |
| POST | `/sections` | 03, 04, 05, 07 |
| PUT | `/sections/:id` | 07 |
| DELETE | `/sections/:id` | 07 |
| PUT | `/sections/:id/restore` | 07 |
| GET | `/topics` | 03, 07 |
| POST | `/topics` | 03, 04, 05, 07 |
| PUT | `/topics/:id` | 07 |
| DELETE | `/topics/:id` | 07 |
| PUT | `/topics/:id/restore` | 07 |
| GET | `/summaries` | 03, 07 |
| POST | `/summaries` | 03, 04, 05, 07, 08 |
| PUT | `/summaries/:id` | 07 |
| DELETE | `/summaries/:id` | 07 |
| PUT | `/summaries/:id/restore` | 07 |
| GET | `/keywords` | 03, 07 |
| POST | `/keywords` | 03, 04, 05, 07 |
| PUT | `/keywords/:id` | 07 |
| DELETE | `/keywords/:id` | 07 |
| PUT | `/keywords/:id/restore` | 07 |
| GET | `/content-tree` | 03 |
| GET | `/quiz-questions` | 04, 05, 07 |
| POST | `/quiz-questions` | 04, 05, 07, 08 |
| PUT | `/quiz-questions/:id` | 04, 07 |
| DELETE | `/quiz-questions/:id` | 04, 07 |
| PUT | `/quiz-questions/:id/restore` | 07 |
| GET | `/flashcards` | 04, 05, 07 |
| POST | `/flashcards` | 04, 05, 07, 08 |
| PUT | `/flashcards/:id` | 04, 07 |
| DELETE | `/flashcards/:id` | 04, 07 |
| PUT | `/flashcards/:id/restore` | 07 |
| GET | `/study-queue` | 05 |
| POST | `/quiz-attempts` | 05 |
| POST | `/study-sessions` | 05 |
| PUT | `/study-sessions/:id` | 05 |
| POST | `/reviews` | 05 |
| POST | `/fsrs-states` | 05 |
| GET | `/fsrs-states` | 05 |
| POST | `/bkt-states` | 05 |
| GET | `/bkt-states` | 05 |
| POST | `/daily-activities` | 05 |
| GET | `/daily-activities` | 05 |
| GET | `/topic-progress` | 05 |
| POST | `/gamification/onboarding` | 06 |
| GET | `/gamification/profile` | 06 |
| POST | `/gamification/daily-check-in` | 06 |
| GET | `/gamification/streak-status` | 06 |
| GET | `/gamification/xp-history` | 06 |
| GET | `/gamification/badges` | 06 |
| POST | `/gamification/check-badges` | 06 |
| GET | `/gamification/leaderboard` | 06 |
| GET | `/gamification/notifications` | 06 |
| PUT | `/gamification/daily-goal` | 06 |
| POST | `/gamification/goals/complete` | 06 |

### NOT covered (out of scope for E2E)

These backend routes are not tested because they require external service
credentials, webhook signatures, or are AI/streaming endpoints:

- **AI routes** (`/ai/*`): chat, generate, ingest, embeddings, RAG -- require Gemini/OpenAI keys
- **Billing** (`/billing/*`): Stripe checkout, portal, webhooks -- require Stripe keys + webhook signatures
- **Telegram** (`/telegram/*`): bot interactions -- require Telegram bot token
- **WhatsApp** (`/whatsapp/*`): messaging -- require WhatsApp Cloud API credentials
- **Mux** (`/mux/*`): video upload/playback -- require Mux API keys
- **Calendar** (`/calendar/*`): exam events
- **Search** (`/search/*`): full-text + semantic search
- **Settings** (`/settings/*`): algorithm config, messaging admin
- **Plans** (`/plans/access`, `/plans/diagnostics`): plan access checks
- **Content extras**: keyword-connections, flashcard-images, reorder, publish-summary, prof-notes, subtopics-batch

---

## Execution Order and Dependencies

Tests run in **file name order** (00 through 09). Within each file, tests run in
declaration order. This ordering matters because:

1. **00-smoke** verifies the API is reachable (prerequisite for everything)
2. **01-auth** validates auth works (needed by all subsequent tests)
3. **02-owner** tests institution/membership management
4. **03-content** creates the full content hierarchy
5. **04-instruments** builds on content to test quiz/flashcard CRUD
6. **05-learning** exercises the complete study loop (depends on content + instruments)
7. **06-gamification** tests the XP/streak/badge system
8. **07-lifecycle** does deep CRUD lifecycle for every entity type
9. **08-security** tests RBAC boundaries (requires both admin and student tokens)
10. **09-edge-cases** tests error handling and robustness

Within each file, tests that share state (e.g., a courseId created in one test
and used in the next) rely on Deno's sequential test execution within a file.

---

## Known Limitations

1. **Tests are ignored when credentials are missing.** The `ignore: !HAS_CREDS`
   pattern means tests show as "ignored" (not "failed") when env vars are unset.
   This is intentional for CI without secrets.

2. **No test isolation between files.** Files 03-05 create and delete their own
   data, but if a test crashes mid-run, orphaned `__e2e_*` entities may remain
   in the database.

3. **AI/billing/messaging endpoints are not covered.** These require external
   API keys and webhook infrastructure that cannot be safely tested in E2E.

4. **Student role tests require a separate user.** `TEST_USER_EMAIL` must be a
   real student-role account in the test institution. Without it, RBAC tests
   (file 08) are skipped.

5. **Rate limiting.** Running the full suite rapidly may hit Supabase Auth rate
   limits (multiple `login()` calls). If tests fail with 429, wait and retry.

6. **Soft-delete cleanup.** The cleanup helper uses `DELETE /resource/:id` which
   performs soft-delete. Hard-deleted data is not possible via the API, so
   `__e2e_*` records accumulate over time in the database (with `deleted_at` set).
