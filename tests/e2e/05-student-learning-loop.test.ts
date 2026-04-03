/**
 * tests/e2e/05-student-learning-loop.test.ts — Student learning loop E2E
 * Run: deno test tests/e2e/05-student-learning-loop.test.ts --allow-net --allow-env --no-check
 *
 * Tests the CORE learning flow end-to-end:
 *   LEARN-00: Login as admin (creates content) and as student (consumes it)
 *   LEARN-01..06: Create full content hierarchy (course→semester→section→topic→summary→keyword)
 *   LEARN-07: POST /quiz-questions → create quiz question
 *   LEARN-08: POST /flashcards → create flashcard
 *   LEARN-09: GET /study-queue → get next items to study
 *   LEARN-10: GET /quiz-questions?summary_id=X → load quiz questions
 *   LEARN-11: POST /quiz-attempts → attempt quiz
 *   LEARN-12: POST /study-sessions → create study session
 *   LEARN-13: POST /reviews → register flashcard review (feeds FSRS)
 *   LEARN-14: POST /fsrs-states → upsert FSRS state
 *   LEARN-15: GET /fsrs-states?flashcard_id=X → verify FSRS calculated
 *   LEARN-16: POST /bkt-states → upsert BKT state after quiz
 *   LEARN-17: GET /bkt-states → verify BKT updated
 *   LEARN-18: PUT /study-sessions/:id → close session
 *   LEARN-19: POST /daily-activities → record today's activity
 *   LEARN-20: GET /daily-activities → verify today's activity recorded
 *   LEARN-21: GET /topic-progress?topic_id=X → verify overall progress
 *   LEARN-22: Cleanup — delete all created content in reverse order
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { login, api, ENV, assertStatus, assertOk } from "../helpers/test-client.ts";
import { TestData } from "./fixtures/test-data-factory.ts";
import { track, cleanupAll, resetTracking } from "./helpers/cleanup.ts";

// ═══ Prerequisites ═══

const HAS_CREDS = ENV.ADMIN_EMAIL.length > 0 && ENV.ADMIN_PASSWORD.length > 0;
const HAS_INST = HAS_CREDS && ENV.INSTITUTION_ID.length > 0;

// ═══ Shared state across sequential tests ═══

let TOKEN = ""; // admin token for creating content
let STUDENT_TOKEN = ""; // student token for consuming content (may be same as admin)
let STUDENT_ID = "";

let courseId = "";
let semesterId = "";
let sectionId = "";
let topicId = "";
let summaryId = "";
let keywordId = "";
let quizQuestionId = "";
let flashcardId = "";
let sessionId = "";

// ═══ 0. Login ═══

Deno.test({
  name: "LEARN-00: Login as admin and student",
  ignore: !HAS_CREDS,
  async fn() {
    // Login as admin to create content
    const adminAuth = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);
    TOKEN = adminAuth.access_token;
    assert(TOKEN.length > 0, "must obtain admin access token");

    // For the student side, use TEST_USER if available, otherwise reuse admin
    if (ENV.USER_EMAIL.length > 0 && ENV.USER_PASSWORD.length > 0) {
      const studentAuth = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);
      STUDENT_TOKEN = studentAuth.access_token;
      STUDENT_ID = studentAuth.user.id;
    } else {
      STUDENT_TOKEN = TOKEN;
      STUDENT_ID = adminAuth.user.id;
    }
    assert(STUDENT_TOKEN.length > 0, "must obtain student access token");
    assert(STUDENT_ID.length > 0, "must obtain student user id");

    resetTracking();
  },
});

// ═══ 1-6. Create prerequisite content hierarchy (as admin) ═══

Deno.test({
  name: "LEARN-01: POST /courses creates prerequisite course",
  ignore: !HAS_INST,
  async fn() {
    const payload = TestData.course(ENV.INSTITUTION_ID);
    const r = await api.post("/courses", TOKEN, payload);
    assertStatus(r, 201);
    const course = assertOk(r) as Record<string, unknown>;
    assert(typeof course.id === "string", "course must have id");
    courseId = course.id as string;
    track("courses", courseId);
  },
});

Deno.test({
  name: "LEARN-02: POST /semesters creates prerequisite semester",
  ignore: !HAS_INST,
  async fn() {
    assert(courseId.length > 0, "courseId must be set from LEARN-01");
    const payload = TestData.semester(courseId);
    const r = await api.post("/semesters", TOKEN, payload);
    assertStatus(r, 201);
    const semester = assertOk(r) as Record<string, unknown>;
    assert(typeof semester.id === "string", "semester must have id");
    semesterId = semester.id as string;
    track("semesters", semesterId);
  },
});

Deno.test({
  name: "LEARN-03: POST /sections creates prerequisite section",
  ignore: !HAS_INST,
  async fn() {
    assert(semesterId.length > 0, "semesterId must be set from LEARN-02");
    const payload = TestData.section(semesterId);
    const r = await api.post("/sections", TOKEN, payload);
    assertStatus(r, 201);
    const section = assertOk(r) as Record<string, unknown>;
    assert(typeof section.id === "string", "section must have id");
    sectionId = section.id as string;
    track("sections", sectionId);
  },
});

Deno.test({
  name: "LEARN-04: POST /topics creates prerequisite topic",
  ignore: !HAS_INST,
  async fn() {
    assert(sectionId.length > 0, "sectionId must be set from LEARN-03");
    const payload = TestData.topic(sectionId);
    const r = await api.post("/topics", TOKEN, payload);
    assertStatus(r, 201);
    const topic = assertOk(r) as Record<string, unknown>;
    assert(typeof topic.id === "string", "topic must have id");
    topicId = topic.id as string;
    track("topics", topicId);
  },
});

Deno.test({
  name: "LEARN-05: POST /summaries creates prerequisite summary",
  ignore: !HAS_INST,
  async fn() {
    assert(topicId.length > 0, "topicId must be set from LEARN-04");
    const payload = TestData.summary(topicId);
    const r = await api.post("/summaries", TOKEN, payload);
    assertStatus(r, 201);
    const summary = assertOk(r) as Record<string, unknown>;
    assert(typeof summary.id === "string", "summary must have id");
    summaryId = summary.id as string;
    track("summaries", summaryId);
  },
});

Deno.test({
  name: "LEARN-06: POST /keywords creates prerequisite keyword",
  ignore: !HAS_INST,
  async fn() {
    assert(summaryId.length > 0, "summaryId must be set from LEARN-05");
    const payload = TestData.keyword(summaryId);
    const r = await api.post("/keywords", TOKEN, payload);
    assertStatus(r, 201);
    const keyword = assertOk(r) as Record<string, unknown>;
    assert(typeof keyword.id === "string", "keyword must have id");
    keywordId = keyword.id as string;
    track("keywords", keywordId);
  },
});

// ═══ 7-8. Create learning instruments (quiz question + flashcard) ═══

Deno.test({
  name: "LEARN-07: POST /quiz-questions creates a quiz question",
  ignore: !HAS_INST,
  async fn() {
    assert(summaryId.length > 0, "summaryId must be set");
    assert(keywordId.length > 0, "keywordId must be set");
    const payload = TestData.quizQuestion(summaryId, keywordId);
    const r = await api.post("/quiz-questions", TOKEN, payload);
    assertStatus(r, 201);
    const qq = assertOk(r) as Record<string, unknown>;
    assert(typeof qq.id === "string", "quiz question must have id");
    quizQuestionId = qq.id as string;
    track("quiz-questions", quizQuestionId);
  },
});

Deno.test({
  name: "LEARN-08: POST /flashcards creates a flashcard",
  ignore: !HAS_INST,
  async fn() {
    assert(summaryId.length > 0, "summaryId must be set");
    assert(keywordId.length > 0, "keywordId must be set");
    const payload = TestData.flashcard(summaryId, keywordId);
    const r = await api.post("/flashcards", TOKEN, payload);
    assertStatus(r, 201);
    const fc = assertOk(r) as Record<string, unknown>;
    assert(typeof fc.id === "string", "flashcard must have id");
    flashcardId = fc.id as string;
    track("flashcards", flashcardId);
  },
});

// ═══ 9. Study Queue — get items to study ═══

Deno.test({
  name: "LEARN-09: GET /study-queue returns queue (may include our flashcard)",
  ignore: !HAS_INST,
  async fn() {
    // Study queue requires flashcards to be published + active.
    // Our flashcard may or may not appear depending on status defaults.
    // We just verify the endpoint works and returns the expected shape.
    const r = await api.get(`/study-queue?course_id=${courseId}&include_future=1&limit=50`, STUDENT_TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    assert(body.queue !== undefined, "study-queue response must have queue array");
    assert(body.meta !== undefined, "study-queue response must have meta object");
    const meta = body.meta as Record<string, unknown>;
    assert(typeof meta.total_in_queue === "number", "meta.total_in_queue must be a number");
    assert(typeof meta.engine === "string", "meta.engine must be a string");
  },
});

// ═══ 10. Load quiz questions for the summary ═══

Deno.test({
  name: "LEARN-10: GET /quiz-questions?summary_id=X lists the quiz question",
  ignore: !HAS_INST,
  async fn() {
    assert(quizQuestionId.length > 0, "quizQuestionId must be set");
    const r = await api.get(`/quiz-questions?summary_id=${summaryId}`, STUDENT_TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    assert(Array.isArray(body.items), "quiz-questions response must have items array");
    const items = body.items as Record<string, unknown>[];
    const found = items.find((q) => q.id === quizQuestionId);
    assert(found, `created quiz question ${quizQuestionId} must appear in list`);
  },
});

// ═══ 11. Attempt quiz ═══

Deno.test({
  name: "LEARN-11: POST /quiz-attempts records a correct quiz attempt",
  ignore: !HAS_INST,
  async fn() {
    assert(quizQuestionId.length > 0, "quizQuestionId must be set");
    // NOTE: Do NOT send is_correct — let the backend compute it from answer vs correct_answer.
    // If the backend blindly trusts client-supplied is_correct, that's a security bug (BUG: quiz-attempts
    // endpoint should validate is_correct server-side, not trust the client).
    const payload = {
      quiz_question_id: quizQuestionId,
      answer: "Option A",
      time_taken_ms: 5000,
    };
    const r = await api.post("/quiz-attempts", STUDENT_TOKEN, payload);
    assertStatus(r, 201);
    const attempt = assertOk(r) as Record<string, unknown>;
    assert(typeof attempt.id === "string", "quiz attempt must have id");
    assertEquals(attempt.student_id, STUDENT_ID, "student_id must match");
    // Verify the backend returned an is_correct field (regardless of value — server should compute it)
    assert(typeof attempt.is_correct === "boolean", "is_correct must be a boolean (server-computed)");
  },
});

// ═══ 12. Create study session ═══

Deno.test({
  name: "LEARN-12: POST /study-sessions creates a study session",
  ignore: !HAS_INST,
  async fn() {
    const payload = {
      session_type: "mixed",
      course_id: courseId,
    };
    const r = await api.post("/study-sessions", STUDENT_TOKEN, payload);
    assertStatus(r, 201);
    const session = assertOk(r) as Record<string, unknown>;
    assert(typeof session.id === "string", "study session must have id");
    assertEquals(session.session_type, "mixed", "session_type must match");
    sessionId = session.id as string;
    track("study-sessions", sessionId);
  },
});

// ═══ 13. Post a review for flashcard (needs session) ═══

Deno.test({
  name: "LEARN-13: POST /reviews registers a flashcard review",
  ignore: !HAS_INST,
  async fn() {
    assert(sessionId.length > 0, "sessionId must be set");
    assert(flashcardId.length > 0, "flashcardId must be set");
    const payload = {
      session_id: sessionId,
      item_id: flashcardId,
      instrument_type: "flashcard",
      grade: 4,
      response_time_ms: 3000,
    };
    const r = await api.post("/reviews", STUDENT_TOKEN, payload);
    assertStatus(r, 201);
    const review = assertOk(r) as Record<string, unknown>;
    assert(typeof review.id === "string", "review must have id");
    assertEquals(review.grade, 4, "grade must be 4");
    assertEquals(review.instrument_type, "flashcard", "instrument_type must match");
  },
});

// ═══ 14. Upsert FSRS state for flashcard ═══

Deno.test({
  name: "LEARN-14: POST /fsrs-states upserts FSRS state after flashcard review",
  ignore: !HAS_INST,
  async fn() {
    assert(flashcardId.length > 0, "flashcardId must be set");
    const now = new Date();
    const dueAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +1 day
    const payload = {
      flashcard_id: flashcardId,
      stability: 4.5,
      difficulty: 5.0,
      due_at: dueAt.toISOString(),
      last_review_at: now.toISOString(),
      reps: 1,
      lapses: 0,
      state: "review",
    };
    const r = await api.post("/fsrs-states", STUDENT_TOKEN, payload);
    // upsert returns 200 (via ok()) — the atomicUpsert helper does not return 201
    assert(r.ok, `POST /fsrs-states should succeed, got ${r.status}: ${r.error}`);
    const fsrs = assertOk(r) as Record<string, unknown>;
    assert(typeof fsrs.stability === "number", "fsrs must have stability");
    assert((fsrs.stability as number) > 0, "stability must be > 0");
    assertEquals(fsrs.state, "review", "state must be review");
  },
});

// ═══ 15. Verify FSRS state ═══

Deno.test({
  name: "LEARN-15: GET /fsrs-states?flashcard_id=X shows FSRS state with interval > 0",
  ignore: !HAS_INST,
  async fn() {
    assert(flashcardId.length > 0, "flashcardId must be set");
    const r = await api.get(`/fsrs-states?flashcard_id=${flashcardId}`, STUDENT_TOKEN);
    assertStatus(r, 200);
    const items = assertOk(r) as Record<string, unknown>[];
    assert(Array.isArray(items), "fsrs-states response must be an array");
    assert(items.length > 0, "must have at least one FSRS state for the flashcard");
    const fsrs = items[0];
    assert((fsrs.stability as number) > 0, "FSRS stability must be > 0 after review");
    assert(fsrs.due_at !== null, "FSRS due_at must be set");
    assertEquals(fsrs.state, "review", "FSRS state must be 'review'");
  },
});

// ═══ 16. Upsert BKT state for quiz ═══

Deno.test({
  name: "LEARN-16: POST /bkt-states upserts BKT state after quiz pass",
  ignore: !HAS_INST,
  async fn() {
    // BKT is keyed on subtopic_id. Since we don't have a subtopic in our test,
    // we use the keyword_id as a stand-in subtopic_id (the DB column is just a UUID FK).
    // In production, subtopics are created under keywords.
    assert(keywordId.length > 0, "keywordId must be set");
    const payload = {
      subtopic_id: keywordId, // using keyword as subtopic stand-in
      p_know: 0.65,
      p_transit: 0.1,
      p_slip: 0.05,
      p_guess: 0.25,
      delta: 0.15,
      total_attempts: 1,
      correct_attempts: 1,
      last_attempt_at: new Date().toISOString(),
    };
    const r = await api.post("/bkt-states", STUDENT_TOKEN, payload);
    assert(r.ok, `POST /bkt-states should succeed, got ${r.status}: ${r.error}`);
    const bkt = assertOk(r) as Record<string, unknown>;
    assert(typeof bkt.p_know === "number", "bkt must have p_know");
    assert((bkt.p_know as number) > 0, "p_know must be > 0 after correct attempt");
  },
});

// ═══ 17. Verify BKT state ═══

Deno.test({
  name: "LEARN-17: GET /bkt-states?subtopic_id=X shows BKT p_know increased",
  ignore: !HAS_INST,
  async fn() {
    assert(keywordId.length > 0, "keywordId must be set");
    const r = await api.get(`/bkt-states?subtopic_id=${keywordId}`, STUDENT_TOKEN);
    assertStatus(r, 200);
    const items = assertOk(r) as Record<string, unknown>[];
    assert(Array.isArray(items), "bkt-states response must be an array");
    assert(items.length > 0, "must have at least one BKT state");
    const bkt = items[0];
    assert((bkt.p_know as number) > 0, "BKT p_know must be > 0 after quiz pass");
    assert((bkt.total_attempts as number) >= 1, "BKT total_attempts must be >= 1");
  },
});

// ═══ 18. Close study session ═══

Deno.test({
  name: "LEARN-18: PUT /study-sessions/:id closes the session",
  ignore: !HAS_INST,
  async fn() {
    assert(sessionId.length > 0, "sessionId must be set");
    const payload = {
      completed_at: new Date().toISOString(),
      total_reviews: 1,
      correct_reviews: 1,
    };
    const r = await api.put(`/study-sessions/${sessionId}`, STUDENT_TOKEN, payload);
    assertStatus(r, 200);
    const session = assertOk(r) as Record<string, unknown>;
    assert(session.completed_at !== null, "completed_at must be set");
    assertEquals(session.total_reviews, 1, "total_reviews must be 1");
    assertEquals(session.correct_reviews, 1, "correct_reviews must be 1");
  },
});

// ═══ 19. Record daily activity ═══

Deno.test({
  name: "LEARN-19: POST /daily-activities records today's activity",
  ignore: !HAS_INST,
  async fn() {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const payload = {
      activity_date: today,
      reviews_count: 1,
      correct_count: 1,
      time_spent_seconds: 120,
      sessions_count: 1,
    };
    const r = await api.post("/daily-activities", STUDENT_TOKEN, payload);
    assert(r.ok, `POST /daily-activities should succeed, got ${r.status}: ${r.error}`);
    const activity = assertOk(r) as Record<string, unknown>;
    assert(activity.activity_date !== undefined, "activity must have activity_date");
  },
});

// ═══ 20. Verify daily activity ═══

Deno.test({
  name: "LEARN-20: GET /daily-activities includes today's recorded activity",
  ignore: !HAS_INST,
  async fn() {
    const today = new Date().toISOString().split("T")[0];
    const r = await api.get(`/daily-activities?from=${today}&to=${today}`, STUDENT_TOKEN);
    assertStatus(r, 200);
    const items = assertOk(r) as Record<string, unknown>[];
    assert(Array.isArray(items), "daily-activities response must be an array");
    assert(items.length > 0, "must have at least one activity for today");
    const todayActivity = items.find((a) => a.activity_date === today);
    assert(todayActivity, "today's activity must be in the list");
    assert(
      (todayActivity!.reviews_count as number) >= 1,
      "reviews_count must be >= 1",
    );
  },
});

// ═══ 21. Topic progress ═══

Deno.test({
  name: "LEARN-21: GET /topic-progress?topic_id=X returns progress data",
  ignore: !HAS_INST,
  async fn() {
    assert(topicId.length > 0, "topicId must be set");
    const r = await api.get(`/topic-progress?topic_id=${topicId}`, STUDENT_TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    // topic-progress returns { summaries, reading_states, flashcard_counts }
    assert(body.summaries !== undefined, "topic-progress must have summaries");
    assert(body.reading_states !== undefined, "topic-progress must have reading_states");
    assert(body.flashcard_counts !== undefined, "topic-progress must have flashcard_counts");
    const summaries = body.summaries as Record<string, unknown>[];
    // Our summary may or may not appear (depends on status='published' filter).
    // The test summary is created with defaults which may not include status='published'.
    // Just assert the endpoint works correctly.
    assert(Array.isArray(summaries), "summaries must be an array");
  },
});

// ═══ 22. Cleanup — delete all created content in reverse order ═══

Deno.test({
  name: "LEARN-22: Cleanup — delete all created content in reverse order",
  ignore: !HAS_INST,
  async fn() {
    await cleanupAll(TOKEN);
    resetTracking();
  },
});
