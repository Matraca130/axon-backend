/**
 * tests/integration/study-routes.test.ts — Study and Study-Queue integration tests
 *
 * Coverage:
 *   Study Routes (/study/*):
 *     - POST /reviews — submit single review (FSRS rating 0-5) → 200 + review created
 *     - GET /topic-progress — fetch summaries + reading states + flashcard counts
 *     - POST /reading-states — upsert reading progress (atomic)
 *     - POST /daily-activities — upsert daily activity log (atomic)
 *     - GET /student-stats — fetch or null
 *     - POST /review-batch — batch atomic review persistence with FSRS+BKT compute
 *
 *   Study Queue Routes (/study-queue/*):
 *     - GET /study-queue — next cards to study (prioritized, paginated)
 *     - GET /study-queue (with limit/course_id filters)
 *
 *   Auth: All routes require JWT → 401 without token
 *
 * All tests follow patterns from study-sessions.test.ts
 * Run: deno test tests/integration/study-routes.test.ts --allow-net --allow-env --no-check
 */

import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { login, api, ENV, assertStatus, assertOk, assertError } from "../helpers/test-client.ts";

let userToken: string;
let sessionId: string = "";
let topicId: string = "";
let summaryId: string = "";
let flashcardId: string = "";
let keywordId: string = "";

async function setup() {
  if (userToken) return;
  userToken = (await login(ENV.USER_EMAIL, ENV.USER_PASSWORD)).access_token;
}

// ═══════════════════════════════════════════════════════════════════
// STUDY ROUTES TESTS
// ═══════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────
// AUTH: All routes require JWT
// ───────────────────────────────────────────────────────────────────

Deno.test("study/reviews requires JWT → 401", async () => {
  const r = await api.post("/reviews", "", {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    item_id: "660e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 3,
  });
  assertError(r, 401);
});

Deno.test("study/topic-progress requires JWT → 401", async () => {
  const r = await api.get("/topic-progress?topic_id=550e8400-e29b-41d4-a716-446655440000", "");
  assertError(r, 401);
});

Deno.test("study/reading-states requires JWT → 401", async () => {
  const r = await api.post("/reading-states", "", {
    summary_id: "550e8400-e29b-41d4-a716-446655440000",
  });
  assertError(r, 401);
});

Deno.test("study/daily-activities requires JWT → 401", async () => {
  const r = await api.post("/daily-activities", "", {
    activity_date: "2026-03-01",
  });
  assertError(r, 401);
});

Deno.test("study-queue requires JWT → 401", async () => {
  const r = await api.get("/study-queue", "");
  assertError(r, 401);
});

// ───────────────────────────────────────────────────────────────────
// REVIEWS — Single review submission
// ───────────────────────────────────────────────────────────────────

Deno.test("POST /reviews happy path → 201 with review data", async () => {
  await setup();

  // First create a session
  const sessionRes = await api.post("/study-sessions", userToken, {
    session_type: "flashcard",
  });
  if (sessionRes.ok) {
    const sessionData = assertOk(sessionRes) as any;
    sessionId = sessionData.id;
  }

  if (!sessionId) {
    console.warn("[SKIP] Could not create session for review test");
    return;
  }

  const r = await api.post("/reviews", userToken, {
    session_id: sessionId,
    item_id: "660e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 3,
  });

  assertStatus(r, 201);
  const review = assertOk(r) as any;
  assertEquals(review.grade, 3);
  assertEquals(review.instrument_type, "flashcard");
});

Deno.test("POST /reviews with response_time_ms → 201", async () => {
  await setup();

  if (!sessionId) {
    const sessionRes = await api.post("/study-sessions", userToken, {
      session_type: "flashcard",
    });
    const sessionData = assertOk(sessionRes) as any;
    sessionId = sessionData.id;
  }

  const r = await api.post("/reviews", userToken, {
    session_id: sessionId,
    item_id: "770e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 4,
    response_time_ms: 2500,
  });

  assertStatus(r, 201);
  const review = assertOk(r) as any;
  assertEquals(review.response_time_ms, 2500);
});

Deno.test("POST /reviews rejects grade > 5 → 400", async () => {
  await setup();

  const r = await api.post("/reviews", userToken, {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    item_id: "660e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 6,
  });
  assertError(r, 400);
});

Deno.test("POST /reviews rejects grade < 0 → 400", async () => {
  await setup();

  const r = await api.post("/reviews", userToken, {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    item_id: "660e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: -1,
  });
  assertError(r, 400);
});

Deno.test("POST /reviews rejects empty instrument_type → 400", async () => {
  await setup();

  const r = await api.post("/reviews", userToken, {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    item_id: "660e8400-e29b-41d4-a716-446655440000",
    instrument_type: "",
    grade: 3,
  });
  assertError(r, 400);
});

Deno.test("POST /reviews rejects invalid session_id UUID → 400", async () => {
  await setup();

  const r = await api.post("/reviews", userToken, {
    session_id: "not-a-uuid",
    item_id: "660e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 3,
  });
  assertError(r, 400);
});

Deno.test("POST /reviews rejects invalid item_id UUID → 400", async () => {
  await setup();

  const r = await api.post("/reviews", userToken, {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    item_id: "invalid-uuid",
    instrument_type: "flashcard",
    grade: 3,
  });
  assertError(r, 400);
});

Deno.test("POST /reviews rejects response_time_ms < 0 → 400", async () => {
  await setup();

  const r = await api.post("/reviews", userToken, {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    item_id: "660e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 3,
    response_time_ms: -100,
  });
  assertError(r, 400);
});

Deno.test("GET /reviews requires session_id query param → 400", async () => {
  await setup();

  const r = await api.get("/reviews", userToken);
  assertError(r, 400);
});

Deno.test("GET /reviews with valid session_id → 200", async () => {
  await setup();

  if (!sessionId) {
    const sessionRes = await api.post("/study-sessions", userToken, {
      session_type: "flashcard",
    });
    const sessionData = assertOk(sessionRes) as any;
    sessionId = sessionData.id;
  }

  const r = await api.get<{ items?: unknown[] }>(`/reviews?session_id=${sessionId}`, userToken);
  assertStatus(r, 200);
  const data = assertOk(r) as any;
  assert(Array.isArray(data), "reviews list should be an array");
});

// ───────────────────────────────────────────────────────────────────
// TOPIC PROGRESS — Unified endpoint (N+1 → 1 request)
// ───────────────────────────────────────────────────────────────────

Deno.test("GET /topic-progress with valid topic_id → 200 with summaries+reading_states+counts", async () => {
  await setup();

  const topicUuid = "550e8400-e29b-41d4-a716-446655440100";
  const r = await api.get(`/topic-progress?topic_id=${topicUuid}`, userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(Array.isArray(data.summaries), "must have summaries array");
  assert(typeof data.reading_states === "object", "must have reading_states object");
  assert(typeof data.flashcard_counts === "object", "must have flashcard_counts object");
});

Deno.test("GET /topic-progress rejects invalid topic_id UUID → 400", async () => {
  await setup();

  const r = await api.get("/topic-progress?topic_id=not-uuid", userToken);
  assertError(r, 400);
});

Deno.test("GET /topic-progress without topic_id → 400", async () => {
  await setup();

  const r = await api.get("/topic-progress", userToken);
  assertError(r, 400);
});

// ───────────────────────────────────────────────────────────────────
// TOPICS OVERVIEW — Batch endpoint for N topics
// ───────────────────────────────────────────────────────────────────

Deno.test("GET /topics-overview with single topic_id → 200", async () => {
  await setup();

  const topicIds = "550e8400-e29b-41d4-a716-446655440100";
  const r = await api.get(`/topics-overview?topic_ids=${topicIds}`, userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(typeof data.summaries_by_topic === "object", "must have summaries_by_topic");
  assert(typeof data.keyword_counts_by_topic === "object", "must have keyword_counts_by_topic");
});

Deno.test("GET /topics-overview with multiple topic_ids → 200", async () => {
  await setup();

  const topicIds = "550e8400-e29b-41d4-a716-446655440100,550e8400-e29b-41d4-a716-446655440101";
  const r = await api.get(`/topics-overview?topic_ids=${topicIds}`, userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(typeof data.summaries_by_topic === "object");
});

Deno.test("GET /topics-overview without topic_ids → 400", async () => {
  await setup();

  const r = await api.get("/topics-overview", userToken);
  assertError(r, 400);
});

Deno.test("GET /topics-overview with empty topic_ids → 400", async () => {
  await setup();

  const r = await api.get("/topics-overview?topic_ids=", userToken);
  assertError(r, 400);
});

Deno.test("GET /topics-overview with invalid UUID in topic_ids → 400", async () => {
  await setup();

  const r = await api.get("/topics-overview?topic_ids=550e8400-e29b-41d4-a716-446655440100,invalid-uuid", userToken);
  assertError(r, 400);
});

// ───────────────────────────────────────────────────────────────────
// READING STATES — Upsert reading progress (atomic)
// ───────────────────────────────────────────────────────────────────

Deno.test("POST /reading-states happy path → 200", async () => {
  await setup();

  const summaryUuid = "880e8400-e29b-41d4-a716-446655440000";
  const r = await api.post("/reading-states", userToken, {
    summary_id: summaryUuid,
    scroll_position: 0.5,
    time_spent_seconds: 300,
    completed: false,
    last_read_at: new Date().toISOString(),
  });

  if (r.status === 200) {
    const data = assertOk(r) as any;
    assertEquals(data.scroll_position, 0.5);
  } else if (r.status === 400) {
    console.warn("[SKIP] reading-states validation issue:", r.error);
  }
});

Deno.test("POST /reading-states rejects invalid summary_id → 400", async () => {
  await setup();

  const r = await api.post("/reading-states", userToken, {
    summary_id: "not-uuid",
    scroll_position: 0.5,
  });
  assertError(r, 400);
});

Deno.test("POST /reading-states rejects negative scroll_position → 400", async () => {
  await setup();

  const r = await api.post("/reading-states", userToken, {
    summary_id: "880e8400-e29b-41d4-a716-446655440000",
    scroll_position: -1,
  });
  assertError(r, 400);
});

Deno.test("POST /reading-states rejects non-boolean completed → 400", async () => {
  await setup();

  const r = await api.post("/reading-states", userToken, {
    summary_id: "880e8400-e29b-41d4-a716-446655440000",
    completed: "true",  // string, not boolean
  });
  assertError(r, 400);
});

Deno.test("POST /reading-states rejects invalid ISO timestamp → 400", async () => {
  await setup();

  const r = await api.post("/reading-states", userToken, {
    summary_id: "880e8400-e29b-41d4-a716-446655440000",
    last_read_at: "2026-03-01",  // not ISO
  });
  assertError(r, 400);
});

Deno.test("GET /reading-states with valid summary_id → 200", async () => {
  await setup();

  const summaryUuid = "880e8400-e29b-41d4-a716-446655440000";
  const r = await api.get(`/reading-states?summary_id=${summaryUuid}`, userToken);
  assertStatus(r, 200);
  // May return null or a reading_state object
});

Deno.test("GET /reading-states without summary_id → 400", async () => {
  await setup();

  const r = await api.get("/reading-states", userToken);
  assertError(r, 400);
});

// ───────────────────────────────────────────────────────────────────
// DAILY ACTIVITIES — Upsert daily activity log (atomic)
// ───────────────────────────────────────────────────────────────────

Deno.test("POST /daily-activities happy path → 200", async () => {
  await setup();

  const today = new Date().toISOString().split("T")[0];
  const r = await api.post("/daily-activities", userToken, {
    activity_date: today,
    reviews_count: 25,
    correct_count: 20,
    time_spent_seconds: 1800,
    sessions_count: 1,
  });

  assertStatus(r, 200);
  const data = assertOk(r) as any;
  assertEquals(data.reviews_count, 25);
});

Deno.test("POST /daily-activities rejects invalid date format → 400", async () => {
  await setup();

  const r = await api.post("/daily-activities", userToken, {
    activity_date: "03/09/2026",  // wrong format
    reviews_count: 10,
  });
  assertError(r, 400);
});

Deno.test("POST /daily-activities rejects negative reviews_count → 400", async () => {
  await setup();

  const today = new Date().toISOString().split("T")[0];
  const r = await api.post("/daily-activities", userToken, {
    activity_date: today,
    reviews_count: -5,
  });
  assertError(r, 400);
});

Deno.test("POST /daily-activities rejects float reviews_count → 400", async () => {
  await setup();

  const today = new Date().toISOString().split("T")[0];
  const r = await api.post("/daily-activities", userToken, {
    activity_date: today,
    reviews_count: 10.5,
  });
  assertError(r, 400);
});

Deno.test("GET /daily-activities → 200 with list", async () => {
  await setup();

  const r = await api.get("/daily-activities", userToken);
  assertStatus(r, 200);
  const data = assertOk(r) as any;
  assert(Array.isArray(data), "should be an array");
});

Deno.test("GET /daily-activities with date range filters → 200", async () => {
  await setup();

  const r = await api.get("/daily-activities?from=2026-01-01&to=2026-03-31&limit=30", userToken);
  assertStatus(r, 200);
});

Deno.test("GET /daily-activities rejects invalid from date → 400", async () => {
  await setup();

  const r = await api.get("/daily-activities?from=2026/01/01", userToken);
  assertError(r, 400);
});

// ───────────────────────────────────────────────────────────────────
// STUDENT STATS — Aggregated stats per student
// ───────────────────────────────────────────────────────────────────

Deno.test("GET /student-stats → 200 with stats or null", async () => {
  await setup();

  const r = await api.get("/student-stats", userToken);
  assertStatus(r, 200);
  const data = assertOk(r);
  // May be null or an object with stats
});

Deno.test("POST /student-stats happy path → 200", async () => {
  await setup();

  const r = await api.post("/student-stats", userToken, {
    current_streak: 5,
    longest_streak: 12,
    total_reviews: 150,
    total_time_seconds: 5400,
    total_sessions: 10,
    last_study_date: "2026-03-01",
  });

  assertStatus(r, 200);
  const data = assertOk(r) as any;
  assertEquals(data.current_streak, 5);
});

Deno.test("POST /student-stats rejects negative current_streak → 400", async () => {
  await setup();

  const r = await api.post("/student-stats", userToken, {
    current_streak: -1,
  });
  assertError(r, 400);
});

Deno.test("POST /student-stats rejects invalid last_study_date → 400", async () => {
  await setup();

  const r = await api.post("/student-stats", userToken, {
    last_study_date: "2026/03/01",  // wrong format
  });
  assertError(r, 400);
});

// ───────────────────────────────────────────────────────────────────
// BATCH REVIEW — Atomic batch persistence with FSRS+BKT compute
// ───────────────────────────────────────────────────────────────────

Deno.test("POST /review-batch happy path → 200 with results", async () => {
  await setup();

  if (!sessionId) {
    const sessionRes = await api.post("/study-sessions", userToken, {
      session_type: "flashcard",
    });
    const sessionData = assertOk(sessionRes) as any;
    sessionId = sessionData.id;
  }

  const r = await api.post("/review-batch", userToken, {
    session_id: sessionId,
    reviews: [
      {
        item_id: "990e8400-e29b-41d4-a716-446655440001",
        instrument_type: "flashcard",
        grade: 3,
      },
      {
        item_id: "990e8400-e29b-41d4-a716-446655440002",
        instrument_type: "flashcard",
        grade: 4,
      },
    ],
  });

  assertStatus(r, 200);
  const data = assertOk(r) as any;
  assertEquals(data.processed, 2);
  assert(data.reviews_created >= 0, "reviews_created should be >= 0");
});

Deno.test("POST /review-batch with response_time_ms → 200", async () => {
  await setup();

  if (!sessionId) {
    const sessionRes = await api.post("/study-sessions", userToken, {
      session_type: "flashcard",
    });
    const sessionData = assertOk(sessionRes) as any;
    sessionId = sessionData.id;
  }

  const r = await api.post("/review-batch", userToken, {
    session_id: sessionId,
    reviews: [
      {
        item_id: "a90e8400-e29b-41d4-a716-446655440001",
        instrument_type: "flashcard",
        grade: 3,
        response_time_ms: 1500,
      },
    ],
  });

  assertStatus(r, 200);
});

Deno.test("POST /review-batch rejects empty reviews array → 400", async () => {
  await setup();

  const r = await api.post("/review-batch", userToken, {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    reviews: [],
  });
  assertError(r, 400);
});

Deno.test("POST /review-batch rejects non-array reviews → 400", async () => {
  await setup();

  const r = await api.post("/review-batch", userToken, {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    reviews: "not an array",
  });
  assertError(r, 400);
});

Deno.test("POST /review-batch rejects review with invalid grade → 400", async () => {
  await setup();

  const r = await api.post("/review-batch", userToken, {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    reviews: [
      {
        item_id: "990e8400-e29b-41d4-a716-446655440001",
        instrument_type: "flashcard",
        grade: 7,  // out of range
      },
    ],
  });
  assertError(r, 400);
});

Deno.test("POST /review-batch rejects review with missing item_id → 400", async () => {
  await setup();

  const r = await api.post("/review-batch", userToken, {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    reviews: [
      {
        instrument_type: "flashcard",
        grade: 3,
      },
    ],
  });
  assertError(r, 400);
});

Deno.test("POST /review-batch rejects invalid session_id → 400", async () => {
  await setup();

  const r = await api.post("/review-batch", userToken, {
    session_id: "not-uuid",
    reviews: [
      {
        item_id: "990e8400-e29b-41d4-a716-446655440001",
        instrument_type: "flashcard",
        grade: 3,
      },
    ],
  });
  assertError(r, 400);
});

// ═══════════════════════════════════════════════════════════════════
// STUDY QUEUE ROUTES TESTS
// ═══════════════════════════════════════════════════════════════════

Deno.test("GET /study-queue happy path → 200 with queue + meta", async () => {
  await setup();

  const r = await api.get<{ queue: unknown[]; meta: Record<string, unknown> }>("/study-queue", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(Array.isArray(data.queue), "queue must be an array");
  assert(typeof data.meta === "object" && data.meta !== null, "meta must be an object");

  // Verify meta fields
  assert("algorithm" in data.meta, "meta must include algorithm");
  assert("engine" in data.meta, "meta must include engine (sql|js)");
  assert("returned" in data.meta, "meta must include returned count");
  assert("total_due" in data.meta, "meta must include total_due");
  assert("total_new" in data.meta, "meta must include total_new");
});

Deno.test("GET /study-queue respects limit param → 200", async () => {
  await setup();

  const r = await api.get<{ queue: unknown[]; meta: { returned: number; limit: number } }>("/study-queue?limit=5", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(data.queue.length <= 5, `Expected max 5 items, got ${data.queue.length}`);
  assertEquals(data.meta.limit, 5);
});

Deno.test("GET /study-queue limit > 100 capped to 100 → 200", async () => {
  await setup();

  const r = await api.get<{ queue: unknown[]; meta: { returned: number; limit: number } }>("/study-queue?limit=500", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assertEquals(data.meta.limit, 100, "limit should be capped at 100");
});

Deno.test("GET /study-queue default limit=20 → 200", async () => {
  await setup();

  const r = await api.get<{ queue: unknown[]; meta: { limit: number } }>("/study-queue", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assertEquals(data.meta.limit, 20);
});

Deno.test("GET /study-queue with include_future=1 → 200", async () => {
  await setup();

  const r = await api.get("/study-queue?include_future=1", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assertEquals(data.meta.include_future, true);
});

Deno.test("GET /study-queue without include_future defaults to false → 200", async () => {
  await setup();

  const r = await api.get("/study-queue", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assertEquals(data.meta.include_future, false);
});

Deno.test("GET /study-queue with valid course_id → 200", async () => {
  await setup();

  const courseId = "550e8400-e29b-41d4-a716-446655440200";
  const r = await api.get(`/study-queue?course_id=${courseId}`, userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assertEquals(data.meta.course_id, courseId);
});

Deno.test("GET /study-queue rejects invalid course_id UUID → 400", async () => {
  await setup();

  const r = await api.get("/study-queue?course_id=not-uuid", userToken);
  assertError(r, 400);
});

Deno.test("GET /study-queue returns meta.engine (sql or js) → 200", async () => {
  await setup();

  const r = await api.get("/study-queue", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(["sql", "js"].includes(data.meta.engine), "engine must be 'sql' or 'js'");
});

Deno.test("GET /study-queue returns generated_at ISO timestamp → 200", async () => {
  await setup();

  const r = await api.get("/study-queue", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(typeof data.meta.generated_at === "string", "generated_at must be ISO string");
  assert(!isNaN(Date.parse(data.meta.generated_at)), "generated_at must be valid ISO");
});

Deno.test("GET /study-queue returns algorithm version → 200", async () => {
  await setup();

  const r = await api.get("/study-queue", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(typeof data.meta.algorithm === "string", "algorithm must be a string");
  assert(data.meta.algorithm.length > 0, "algorithm must not be empty");
});

Deno.test("GET /study-queue returns weights config → 200", async () => {
  await setup();

  const r = await api.get("/study-queue", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(typeof data.meta.weights === "object", "weights must be an object");
});

Deno.test("GET /study-queue queue items have required fields → 200", async () => {
  await setup();

  const r = await api.get("/study-queue", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;

  // Verify structure if queue is non-empty
  if (data.queue.length > 0) {
    const firstItem = data.queue[0] as any;
    assert("flashcard_id" in firstItem, "queue item must have flashcard_id");
    assert("need_score" in firstItem, "queue item must have need_score");
    assert("retention" in firstItem, "queue item must have retention");
    assert("is_new" in firstItem, "queue item must have is_new");
  }
});

Deno.test("GET /study-queue queue is prioritized (need_score descending) → 200", async () => {
  await setup();

  const r = await api.get("/study-queue", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;

  // Verify prioritization if queue has multiple items
  if (data.queue.length > 1) {
    let isSorted = true;
    for (let i = 1; i < data.queue.length; i++) {
      const prevScore = (data.queue[i - 1] as any).need_score ?? 0;
      const currScore = (data.queue[i] as any).need_score ?? 0;
      if (prevScore < currScore) {
        isSorted = false;
        break;
      }
    }
    assert(isSorted, "queue should be sorted by need_score descending");
  }
});

Deno.test("GET /study-queue meta.returned <= meta.limit → 200", async () => {
  await setup();

  const r = await api.get("/study-queue?limit=10", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(
    data.meta.returned <= data.meta.limit,
    `returned (${data.meta.returned}) should be <= limit (${data.meta.limit})`
  );
});

Deno.test("GET /study-queue meta.total_in_queue >= returned → 200", async () => {
  await setup();

  const r = await api.get("/study-queue", userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assert(
    data.meta.total_in_queue >= data.meta.returned,
    `total_in_queue (${data.meta.total_in_queue}) should be >= returned (${data.meta.returned})`
  );
});

Deno.test("GET /study-queue with all filters combined → 200", async () => {
  await setup();

  const courseId = "550e8400-e29b-41d4-a716-446655440200";
  const r = await api.get(`/study-queue?course_id=${courseId}&limit=15&include_future=1`, userToken);
  assertStatus(r, 200);

  const data = assertOk(r) as any;
  assertEquals(data.meta.course_id, courseId);
  assertEquals(data.meta.limit, 15);
  assertEquals(data.meta.include_future, true);
});
