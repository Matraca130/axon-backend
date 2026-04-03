/**
 * tests/e2e/04-professor-instruments.test.ts — Professor instruments CRUD
 * Run: deno test tests/e2e/04-professor-instruments.test.ts --allow-net --allow-env --no-check
 *
 * Tests quiz-questions and flashcards CRUD on top of content hierarchy:
 *   INSTR-00: Login as admin/professor
 *   INSTR-01: POST /courses → create prerequisite course
 *   INSTR-02: POST /semesters → create prerequisite semester
 *   INSTR-03: POST /sections → create prerequisite section
 *   INSTR-04: POST /topics → create prerequisite topic
 *   INSTR-05: POST /summaries → create prerequisite summary
 *   INSTR-06: POST /keywords → create prerequisite keyword
 *   INSTR-07: POST /quiz-questions → create quiz question
 *   INSTR-08: GET /quiz-questions?summary_id=X → verify question exists
 *   INSTR-09: PUT /quiz-questions/:id → update question text
 *   INSTR-10: POST /flashcards → create flashcard
 *   INSTR-11: GET /flashcards?summary_id=X → verify flashcard exists
 *   INSTR-12: PUT /flashcards/:id → update flashcard front text
 *   INSTR-13: DELETE /quiz-questions/:id → delete question
 *   INSTR-14: DELETE /flashcards/:id → delete flashcard
 *   INSTR-15: Cleanup — delete prerequisite content in reverse order
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

let TOKEN = "";
let courseId = "";
let semesterId = "";
let sectionId = "";
let topicId = "";
let summaryId = "";
let keywordId = "";
let quizQuestionId = "";
let flashcardId = "";

// ═══ 0. Login once ═══

Deno.test({
  name: "INSTR-00: Login as admin/professor for instrument tests",
  ignore: !HAS_CREDS,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);
    TOKEN = access_token;
    assert(TOKEN.length > 0, "must obtain access token");
    resetTracking();
  },
});

// ═══ 1-6. Create prerequisite content hierarchy ═══

Deno.test({
  name: "INSTR-01: POST /courses creates prerequisite course",
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
  name: "INSTR-02: POST /semesters creates prerequisite semester",
  ignore: !HAS_INST,
  async fn() {
    assert(courseId.length > 0, "courseId must be set from INSTR-01");
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
  name: "INSTR-03: POST /sections creates prerequisite section",
  ignore: !HAS_INST,
  async fn() {
    assert(semesterId.length > 0, "semesterId must be set from INSTR-02");
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
  name: "INSTR-04: POST /topics creates prerequisite topic",
  ignore: !HAS_INST,
  async fn() {
    assert(sectionId.length > 0, "sectionId must be set from INSTR-03");
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
  name: "INSTR-05: POST /summaries creates prerequisite summary",
  ignore: !HAS_INST,
  async fn() {
    assert(topicId.length > 0, "topicId must be set from INSTR-04");
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
  name: "INSTR-06: POST /keywords creates prerequisite keyword",
  ignore: !HAS_INST,
  async fn() {
    assert(summaryId.length > 0, "summaryId must be set from INSTR-05");
    const payload = TestData.keyword(summaryId);
    const r = await api.post("/keywords", TOKEN, payload);
    assertStatus(r, 201);
    const keyword = assertOk(r) as Record<string, unknown>;
    assert(typeof keyword.id === "string", "keyword must have id");
    keywordId = keyword.id as string;
    track("keywords", keywordId);
  },
});

// ═══ 7. POST /quiz-questions → CREATE QUIZ QUESTION ═══

Deno.test({
  name: "INSTR-07: POST /quiz-questions creates a quiz question",
  ignore: !HAS_INST,
  async fn() {
    assert(summaryId.length > 0, "summaryId must be set from INSTR-05");
    assert(keywordId.length > 0, "keywordId must be set from INSTR-06");

    const payload = TestData.quizQuestion(summaryId, keywordId);
    const r = await api.post("/quiz-questions", TOKEN, payload);
    assertStatus(r, 201);

    const qq = assertOk(r) as Record<string, unknown>;
    assert(typeof qq.id === "string", "quiz question must have id");
    assertEquals(qq.question, payload.question, "question text must match");
    assertEquals(qq.summary_id, summaryId, "summary_id must match");
    assertEquals(qq.keyword_id, keywordId, "keyword_id must match");
    assertEquals(qq.question_type, "multiple_choice", "question_type must match");
    assertEquals(qq.correct_answer, "Option A", "correct_answer must match");

    quizQuestionId = qq.id as string;
    track("quiz-questions", quizQuestionId);
  },
});

// ═══ 8. GET /quiz-questions → VERIFY QUESTION IN LIST ═══

Deno.test({
  name: "INSTR-08: GET /quiz-questions?summary_id=X lists the created question",
  ignore: !HAS_INST,
  async fn() {
    assert(quizQuestionId.length > 0, "quizQuestionId must be set from INSTR-07");

    const r = await api.get(`/quiz-questions?summary_id=${summaryId}`, TOKEN);
    assertStatus(r, 200);

    const body = assertOk(r) as Record<string, unknown>;
    assert(Array.isArray(body.items), "quiz-questions response must have items array");

    const items = body.items as Record<string, unknown>[];
    const found = items.find((q) => q.id === quizQuestionId);
    assert(found, `created quiz question ${quizQuestionId} must appear in list`);
  },
});

// ═══ 9. PUT /quiz-questions/:id → UPDATE QUESTION ═══

Deno.test({
  name: "INSTR-09: PUT /quiz-questions/:id updates question text",
  ignore: !HAS_INST,
  async fn() {
    assert(quizQuestionId.length > 0, "quizQuestionId must be set from INSTR-07");

    const updatedQuestion = `__e2e_question_updated_${Date.now()}__`;
    const r = await api.put(`/quiz-questions/${quizQuestionId}`, TOKEN, {
      question: updatedQuestion,
    });
    assertStatus(r, 200);

    const qq = assertOk(r) as Record<string, unknown>;
    assertEquals(qq.question, updatedQuestion, "question text must be updated");
  },
});

// ═══ 10. POST /flashcards → CREATE FLASHCARD ═══

Deno.test({
  name: "INSTR-10: POST /flashcards creates a flashcard",
  ignore: !HAS_INST,
  async fn() {
    assert(summaryId.length > 0, "summaryId must be set from INSTR-05");
    assert(keywordId.length > 0, "keywordId must be set from INSTR-06");

    const payload = TestData.flashcard(summaryId, keywordId);
    const r = await api.post("/flashcards", TOKEN, payload);
    assertStatus(r, 201);

    const fc = assertOk(r) as Record<string, unknown>;
    assert(typeof fc.id === "string", "flashcard must have id");
    assertEquals(fc.front, payload.front, "front text must match");
    assertEquals(fc.back, payload.back, "back text must match");
    assertEquals(fc.summary_id, summaryId, "summary_id must match");
    assertEquals(fc.keyword_id, keywordId, "keyword_id must match");

    flashcardId = fc.id as string;
    track("flashcards", flashcardId);
  },
});

// ═══ 11. GET /flashcards → VERIFY FLASHCARD IN LIST ═══

Deno.test({
  name: "INSTR-11: GET /flashcards?summary_id=X lists the created flashcard",
  ignore: !HAS_INST,
  async fn() {
    assert(flashcardId.length > 0, "flashcardId must be set from INSTR-10");

    const r = await api.get(`/flashcards?summary_id=${summaryId}`, TOKEN);
    assertStatus(r, 200);

    const body = assertOk(r) as Record<string, unknown>;
    assert(Array.isArray(body.items), "flashcards response must have items array");

    const items = body.items as Record<string, unknown>[];
    const found = items.find((f) => f.id === flashcardId);
    assert(found, `created flashcard ${flashcardId} must appear in list`);
  },
});

// ═══ 12. PUT /flashcards/:id → UPDATE FLASHCARD ═══

Deno.test({
  name: "INSTR-12: PUT /flashcards/:id updates flashcard front text",
  ignore: !HAS_INST,
  async fn() {
    assert(flashcardId.length > 0, "flashcardId must be set from INSTR-10");

    const updatedFront = `__e2e_front_updated_${Date.now()}__`;
    const r = await api.put(`/flashcards/${flashcardId}`, TOKEN, {
      front: updatedFront,
    });
    assertStatus(r, 200);

    const fc = assertOk(r) as Record<string, unknown>;
    assertEquals(fc.front, updatedFront, "front text must be updated");
  },
});

// ═══ 13. DELETE /quiz-questions/:id → DELETE QUESTION ═══

Deno.test({
  name: "INSTR-13: DELETE /quiz-questions/:id soft-deletes the question",
  ignore: !HAS_INST,
  async fn() {
    assert(quizQuestionId.length > 0, "quizQuestionId must be set from INSTR-07");

    const r = await api.delete(`/quiz-questions/${quizQuestionId}`, TOKEN);
    assertStatus(r, 200);

    const qq = assertOk(r) as Record<string, unknown>;
    assert(qq.deleted_at !== null, "deleted_at must be set after soft-delete");

    // Verify it no longer appears in default list (soft-deleted items filtered out)
    const listR = await api.get(`/quiz-questions?summary_id=${summaryId}`, TOKEN);
    assertStatus(listR, 200);
    const body = assertOk(listR) as Record<string, unknown>;
    const items = (body.items as Record<string, unknown>[]) ?? [];
    const found = items.find((q) => q.id === quizQuestionId);
    assert(!found, "soft-deleted quiz question must NOT appear in default list");
  },
});

// ═══ 14. DELETE /flashcards/:id → DELETE FLASHCARD ═══

Deno.test({
  name: "INSTR-14: DELETE /flashcards/:id soft-deletes the flashcard",
  ignore: !HAS_INST,
  async fn() {
    assert(flashcardId.length > 0, "flashcardId must be set from INSTR-10");

    const r = await api.delete(`/flashcards/${flashcardId}`, TOKEN);
    assertStatus(r, 200);

    const fc = assertOk(r) as Record<string, unknown>;
    assert(fc.deleted_at !== null, "deleted_at must be set after soft-delete");

    // Verify it no longer appears in default list
    const listR = await api.get(`/flashcards?summary_id=${summaryId}`, TOKEN);
    assertStatus(listR, 200);
    const body = assertOk(listR) as Record<string, unknown>;
    const items = (body.items as Record<string, unknown>[]) ?? [];
    const found = items.find((f) => f.id === flashcardId);
    assert(!found, "soft-deleted flashcard must NOT appear in default list");
  },
});

// ═══ 15. Cleanup — delete prerequisite content in reverse order ═══

Deno.test({
  name: "INSTR-15: Cleanup — delete all prerequisite content in reverse order",
  ignore: !HAS_INST,
  async fn() {
    // quiz-questions and flashcards already deleted in INSTR-13/14.
    // cleanupAll deletes remaining tracked entities in LIFO order
    // (keywords → summaries → topics → sections → semesters → courses).
    await cleanupAll(TOKEN);
    resetTracking();
  },
});
