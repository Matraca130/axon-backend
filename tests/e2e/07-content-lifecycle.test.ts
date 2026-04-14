/**
 * tests/e2e/07-content-lifecycle.test.ts — Full CRUD lifecycle with soft-delete & restore
 * Run: deno test tests/e2e/07-content-lifecycle.test.ts --allow-net --allow-env --no-check
 *
 * For each entity type in the content hierarchy + instruments:
 *   1. Create entity -> GET -> exists
 *   2. PUT -> update -> GET -> change reflected
 *   3. DELETE -> soft-delete -> GET list -> NOT visible
 *   4. GET list with ?include_deleted=true -> visible
 *   5. PUT /:id/restore -> GET list -> visible again
 *   6. Final cleanup
 *
 * Entity types tested:
 *   LIFE-01..06: courses
 *   LIFE-07..12: semesters
 *   LIFE-13..18: sections
 *   LIFE-19..24: topics
 *   LIFE-25..30: summaries
 *   LIFE-31..36: keywords
 *   LIFE-37..42: flashcards
 *   LIFE-43..48: quiz-questions
 *   LIFE-99: Final cleanup
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { login, api, ENV, assertStatus, assertOk } from "../helpers/test-client.ts";
import { TestData } from "./fixtures/test-data-factory.ts";
import { track, cleanupAll, resetTracking } from "./helpers/cleanup.ts";

// ═══ Prerequisites ═══

const HAS_CREDS = ENV.ADMIN_EMAIL.length > 0 && ENV.ADMIN_PASSWORD.length > 0;
const HAS_INST = HAS_CREDS && ENV.INSTITUTION_ID.length > 0;

// ═══ Shared state ═══

let TOKEN = "";

// Content hierarchy IDs (created once, reused across all lifecycle tests)
let courseId = "";
let semesterId = "";
let sectionId = "";
let topicId = "";
let summaryId = "";
let keywordId = "";

// Lifecycle target IDs (each entity type gets its own lifecycle target)
let lifeCourseId = "";
let lifeSemesterId = "";
let lifeSectionId = "";
let lifeTopicId = "";
let lifeSummaryId = "";
let lifeKeywordId = "";
let lifeFlashcardId = "";
let lifeQuizQuestionId = "";

// ═══ 0. Login ═══

Deno.test({
  name: "LIFE-00: Login as admin/professor for lifecycle tests",
  ignore: !HAS_CREDS,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);
    TOKEN = access_token;
    assert(TOKEN.length > 0, "must obtain access token");
    resetTracking();
  },
});

// ═══ Build prerequisite content hierarchy ═══
// We need: course -> semester -> section -> topic -> summary -> keyword
// These are the "parent" chain that lifecycle targets will be created under.

Deno.test({
  name: "LIFE-00a: Create prerequisite content hierarchy",
  ignore: !HAS_INST,
  async fn() {
    // Course
    const cr = await api.post("/courses", TOKEN, TestData.course(ENV.INSTITUTION_ID));
    assertStatus(cr, 201);
    courseId = (assertOk(cr) as Record<string, unknown>).id as string;
    track("courses", courseId);

    // Semester
    const sr = await api.post("/semesters", TOKEN, TestData.semester(courseId));
    assertStatus(sr, 201);
    semesterId = (assertOk(sr) as Record<string, unknown>).id as string;
    track("semesters", semesterId);

    // Section
    const secr = await api.post("/sections", TOKEN, TestData.section(semesterId));
    assertStatus(secr, 201);
    sectionId = (assertOk(secr) as Record<string, unknown>).id as string;
    track("sections", sectionId);

    // Topic
    const tr = await api.post("/topics", TOKEN, TestData.topic(sectionId));
    assertStatus(tr, 201);
    topicId = (assertOk(tr) as Record<string, unknown>).id as string;
    track("topics", topicId);

    // Summary
    const sumr = await api.post("/summaries", TOKEN, TestData.summary(topicId));
    assertStatus(sumr, 201);
    summaryId = (assertOk(sumr) as Record<string, unknown>).id as string;
    track("summaries", summaryId);

    // Keyword
    const kwr = await api.post("/keywords", TOKEN, TestData.keyword(summaryId));
    assertStatus(kwr, 201);
    keywordId = (assertOk(kwr) as Record<string, unknown>).id as string;
    track("keywords", keywordId);

    assert(keywordId.length > 0, "full hierarchy must be created");
  },
});

// ═══════════════════════════════════════════════════════════════════════
// COURSES LIFECYCLE (LIFE-01..06)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "LIFE-01: Course — Create",
  ignore: !HAS_INST,
  async fn() {
    const payload = TestData.course(ENV.INSTITUTION_ID);
    const r = await api.post("/courses", TOKEN, payload);
    assertStatus(r, 201);
    const course = assertOk(r) as Record<string, unknown>;
    lifeCourseId = course.id as string;
    assertEquals(course.name, payload.name);
    track("courses", lifeCourseId);
  },
});

Deno.test({
  name: "LIFE-02: Course — Update name",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeCourseId, "lifeCourseId must be set");
    const newName = `__e2e_course_updated_${Date.now()}__`;
    const r = await api.put(`/courses/${lifeCourseId}`, TOKEN, { name: newName });
    assertStatus(r, 200);
    const course = assertOk(r) as Record<string, unknown>;
    assertEquals(course.name, newName, "name must be updated");
  },
});

Deno.test({
  name: "LIFE-03: Course — Soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeCourseId, "lifeCourseId must be set");
    const r = await api.delete(`/courses/${lifeCourseId}`, TOKEN);
    assertStatus(r, 200);
    const course = assertOk(r) as Record<string, unknown>;
    assert(course.deleted_at !== null, "deleted_at must be set");
  },
});

Deno.test({
  name: "LIFE-04: Course — Not visible in default list after soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeCourseId, "lifeCourseId must be set");
    const r = await api.get(`/courses?institution_id=${ENV.INSTITUTION_ID}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((c) => c.id === lifeCourseId);
    assert(!found, "soft-deleted course must NOT appear in default list");
  },
});

Deno.test({
  name: "LIFE-05: Course — Visible with include_deleted=true",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeCourseId, "lifeCourseId must be set");
    const r = await api.get(
      `/courses?institution_id=${ENV.INSTITUTION_ID}&include_deleted=true`,
      TOKEN,
    );
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((c) => c.id === lifeCourseId);
    assert(found, "soft-deleted course must appear with include_deleted=true");
  },
});

Deno.test({
  name: "LIFE-06: Course — Restore",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeCourseId, "lifeCourseId must be set");
    const r = await api.put(`/courses/${lifeCourseId}/restore`, TOKEN, {});
    assertStatus(r, 200);
    const course = assertOk(r) as Record<string, unknown>;
    assertEquals(course.deleted_at, null, "deleted_at must be null after restore");
    assertEquals(course.is_active, true, "is_active must be true after restore");

    // Verify visible in default list again
    const listR = await api.get(`/courses?institution_id=${ENV.INSTITUTION_ID}`, TOKEN);
    const listBody = assertOk(listR) as Record<string, unknown>;
    const items = listBody.items as Record<string, unknown>[];
    const found = items.find((c) => c.id === lifeCourseId);
    assert(found, "restored course must appear in default list");
  },
});

// ═══════════════════════════════════════════════════════════════════════
// SEMESTERS LIFECYCLE (LIFE-07..12)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "LIFE-07: Semester — Create",
  ignore: !HAS_INST,
  async fn() {
    const payload = TestData.semester(courseId);
    const r = await api.post("/semesters", TOKEN, payload);
    assertStatus(r, 201);
    const sem = assertOk(r) as Record<string, unknown>;
    lifeSemesterId = sem.id as string;
    assertEquals(sem.name, payload.name);
    track("semesters", lifeSemesterId);
  },
});

Deno.test({
  name: "LIFE-08: Semester — Update name",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSemesterId, "lifeSemesterId must be set");
    const newName = `__e2e_semester_updated_${Date.now()}__`;
    const r = await api.put(`/semesters/${lifeSemesterId}`, TOKEN, { name: newName });
    assertStatus(r, 200);
    const sem = assertOk(r) as Record<string, unknown>;
    assertEquals(sem.name, newName);
  },
});

Deno.test({
  name: "LIFE-09: Semester — Soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSemesterId, "lifeSemesterId must be set");
    const r = await api.delete(`/semesters/${lifeSemesterId}`, TOKEN);
    assertStatus(r, 200);
    const sem = assertOk(r) as Record<string, unknown>;
    assert(sem.deleted_at !== null, "deleted_at must be set");
  },
});

Deno.test({
  name: "LIFE-10: Semester — Not visible in default list after soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSemesterId, "lifeSemesterId must be set");
    const r = await api.get(`/semesters?course_id=${courseId}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((s) => s.id === lifeSemesterId);
    assert(!found, "soft-deleted semester must NOT appear in default list");
  },
});

Deno.test({
  name: "LIFE-11: Semester — Visible with include_deleted=true",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSemesterId, "lifeSemesterId must be set");
    const r = await api.get(`/semesters?course_id=${courseId}&include_deleted=true`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((s) => s.id === lifeSemesterId);
    assert(found, "soft-deleted semester must appear with include_deleted=true");
  },
});

Deno.test({
  name: "LIFE-12: Semester — Restore",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSemesterId, "lifeSemesterId must be set");
    const r = await api.put(`/semesters/${lifeSemesterId}/restore`, TOKEN, {});
    assertStatus(r, 200);
    const sem = assertOk(r) as Record<string, unknown>;
    assertEquals(sem.deleted_at, null);
    assertEquals(sem.is_active, true);
  },
});

// ═══════════════════════════════════════════════════════════════════════
// SECTIONS LIFECYCLE (LIFE-13..18)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "LIFE-13: Section — Create",
  ignore: !HAS_INST,
  async fn() {
    const payload = TestData.section(semesterId);
    const r = await api.post("/sections", TOKEN, payload);
    assertStatus(r, 201);
    const sec = assertOk(r) as Record<string, unknown>;
    lifeSectionId = sec.id as string;
    assertEquals(sec.name, payload.name);
    track("sections", lifeSectionId);
  },
});

Deno.test({
  name: "LIFE-14: Section — Update name",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSectionId, "lifeSectionId must be set");
    const newName = `__e2e_section_updated_${Date.now()}__`;
    const r = await api.put(`/sections/${lifeSectionId}`, TOKEN, { name: newName });
    assertStatus(r, 200);
    const sec = assertOk(r) as Record<string, unknown>;
    assertEquals(sec.name, newName);
  },
});

Deno.test({
  name: "LIFE-15: Section — Soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSectionId, "lifeSectionId must be set");
    const r = await api.delete(`/sections/${lifeSectionId}`, TOKEN);
    assertStatus(r, 200);
    const sec = assertOk(r) as Record<string, unknown>;
    assert(sec.deleted_at !== null, "deleted_at must be set");
  },
});

Deno.test({
  name: "LIFE-16: Section — Not visible in default list after soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSectionId, "lifeSectionId must be set");
    const r = await api.get(`/sections?semester_id=${semesterId}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((s) => s.id === lifeSectionId);
    assert(!found, "soft-deleted section must NOT appear in default list");
  },
});

Deno.test({
  name: "LIFE-17: Section — Visible with include_deleted=true",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSectionId, "lifeSectionId must be set");
    const r = await api.get(`/sections?semester_id=${semesterId}&include_deleted=true`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((s) => s.id === lifeSectionId);
    assert(found, "soft-deleted section must appear with include_deleted=true");
  },
});

Deno.test({
  name: "LIFE-18: Section — Restore",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSectionId, "lifeSectionId must be set");
    const r = await api.put(`/sections/${lifeSectionId}/restore`, TOKEN, {});
    assertStatus(r, 200);
    const sec = assertOk(r) as Record<string, unknown>;
    assertEquals(sec.deleted_at, null);
    assertEquals(sec.is_active, true);
  },
});

// ═══════════════════════════════════════════════════════════════════════
// TOPICS LIFECYCLE (LIFE-19..24)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "LIFE-19: Topic — Create",
  ignore: !HAS_INST,
  async fn() {
    const payload = TestData.topic(sectionId);
    const r = await api.post("/topics", TOKEN, payload);
    assertStatus(r, 201);
    const topic = assertOk(r) as Record<string, unknown>;
    lifeTopicId = topic.id as string;
    assertEquals(topic.name, payload.name);
    track("topics", lifeTopicId);
  },
});

Deno.test({
  name: "LIFE-20: Topic — Update name",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeTopicId, "lifeTopicId must be set");
    const newName = `__e2e_topic_updated_${Date.now()}__`;
    const r = await api.put(`/topics/${lifeTopicId}`, TOKEN, { name: newName });
    assertStatus(r, 200);
    const topic = assertOk(r) as Record<string, unknown>;
    assertEquals(topic.name, newName);
  },
});

Deno.test({
  name: "LIFE-21: Topic — Soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeTopicId, "lifeTopicId must be set");
    const r = await api.delete(`/topics/${lifeTopicId}`, TOKEN);
    assertStatus(r, 200);
    const topic = assertOk(r) as Record<string, unknown>;
    assert(topic.deleted_at !== null, "deleted_at must be set");
  },
});

Deno.test({
  name: "LIFE-22: Topic — Not visible in default list after soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeTopicId, "lifeTopicId must be set");
    const r = await api.get(`/topics?section_id=${sectionId}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((t) => t.id === lifeTopicId);
    assert(!found, "soft-deleted topic must NOT appear in default list");
  },
});

Deno.test({
  name: "LIFE-23: Topic — Visible with include_deleted=true",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeTopicId, "lifeTopicId must be set");
    const r = await api.get(`/topics?section_id=${sectionId}&include_deleted=true`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((t) => t.id === lifeTopicId);
    assert(found, "soft-deleted topic must appear with include_deleted=true");
  },
});

Deno.test({
  name: "LIFE-24: Topic — Restore",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeTopicId, "lifeTopicId must be set");
    const r = await api.put(`/topics/${lifeTopicId}/restore`, TOKEN, {});
    assertStatus(r, 200);
    const topic = assertOk(r) as Record<string, unknown>;
    assertEquals(topic.deleted_at, null);
    assertEquals(topic.is_active, true);
  },
});

// ═══════════════════════════════════════════════════════════════════════
// SUMMARIES LIFECYCLE (LIFE-25..30)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "LIFE-25: Summary — Create",
  ignore: !HAS_INST,
  async fn() {
    const payload = TestData.summary(topicId);
    const r = await api.post("/summaries", TOKEN, payload);
    assertStatus(r, 201);
    const summary = assertOk(r) as Record<string, unknown>;
    lifeSummaryId = summary.id as string;
    assertEquals(summary.title, payload.title);
    track("summaries", lifeSummaryId);
  },
});

Deno.test({
  name: "LIFE-26: Summary — Update title",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSummaryId, "lifeSummaryId must be set");
    const newTitle = `__e2e_summary_updated_${Date.now()}__`;
    const r = await api.put(`/summaries/${lifeSummaryId}`, TOKEN, { title: newTitle });
    assertStatus(r, 200);
    const summary = assertOk(r) as Record<string, unknown>;
    assertEquals(summary.title, newTitle);
  },
});

Deno.test({
  name: "LIFE-27: Summary — Soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSummaryId, "lifeSummaryId must be set");
    const r = await api.delete(`/summaries/${lifeSummaryId}`, TOKEN);
    assertStatus(r, 200);
    const summary = assertOk(r) as Record<string, unknown>;
    assert(summary.deleted_at !== null, "deleted_at must be set");
  },
});

Deno.test({
  name: "LIFE-28: Summary — Not visible in default list after soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSummaryId, "lifeSummaryId must be set");
    const r = await api.get(`/summaries?topic_id=${topicId}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((s) => s.id === lifeSummaryId);
    assert(!found, "soft-deleted summary must NOT appear in default list");
  },
});

Deno.test({
  name: "LIFE-29: Summary — Visible with include_deleted=true",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSummaryId, "lifeSummaryId must be set");
    const r = await api.get(`/summaries?topic_id=${topicId}&include_deleted=true`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((s) => s.id === lifeSummaryId);
    assert(found, "soft-deleted summary must appear with include_deleted=true");
  },
});

Deno.test({
  name: "LIFE-30: Summary — Restore",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeSummaryId, "lifeSummaryId must be set");
    const r = await api.put(`/summaries/${lifeSummaryId}/restore`, TOKEN, {});
    assertStatus(r, 200);
    const summary = assertOk(r) as Record<string, unknown>;
    assertEquals(summary.deleted_at, null);
    assertEquals(summary.is_active, true);
  },
});

// ═══════════════════════════════════════════════════════════════════════
// KEYWORDS LIFECYCLE (LIFE-31..36)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "LIFE-31: Keyword — Create",
  ignore: !HAS_INST,
  async fn() {
    const payload = TestData.keyword(summaryId);
    const r = await api.post("/keywords", TOKEN, payload);
    assertStatus(r, 201);
    const kw = assertOk(r) as Record<string, unknown>;
    lifeKeywordId = kw.id as string;
    assertEquals(kw.name, payload.name);
    track("keywords", lifeKeywordId);
  },
});

Deno.test({
  name: "LIFE-32: Keyword — Update name",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeKeywordId, "lifeKeywordId must be set");
    const newName = `__e2e_keyword_updated_${Date.now()}__`;
    const r = await api.put(`/keywords/${lifeKeywordId}`, TOKEN, { name: newName });
    assertStatus(r, 200);
    const kw = assertOk(r) as Record<string, unknown>;
    assertEquals(kw.name, newName);
  },
});

Deno.test({
  name: "LIFE-33: Keyword — Soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeKeywordId, "lifeKeywordId must be set");
    const r = await api.delete(`/keywords/${lifeKeywordId}`, TOKEN);
    assertStatus(r, 200);
    const kw = assertOk(r) as Record<string, unknown>;
    assert(kw.deleted_at !== null, "deleted_at must be set");
  },
});

Deno.test({
  name: "LIFE-34: Keyword — Not visible in default list after soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeKeywordId, "lifeKeywordId must be set");
    const r = await api.get(`/keywords?summary_id=${summaryId}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((k) => k.id === lifeKeywordId);
    assert(!found, "soft-deleted keyword must NOT appear in default list");
  },
});

Deno.test({
  name: "LIFE-35: Keyword — Visible with include_deleted=true",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeKeywordId, "lifeKeywordId must be set");
    const r = await api.get(`/keywords?summary_id=${summaryId}&include_deleted=true`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((k) => k.id === lifeKeywordId);
    assert(found, "soft-deleted keyword must appear with include_deleted=true");
  },
});

Deno.test({
  name: "LIFE-36: Keyword — Restore",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeKeywordId, "lifeKeywordId must be set");
    const r = await api.put(`/keywords/${lifeKeywordId}/restore`, TOKEN, {});
    assertStatus(r, 200);
    const kw = assertOk(r) as Record<string, unknown>;
    assertEquals(kw.deleted_at, null);
    assertEquals(kw.is_active, true);
  },
});

// ═══════════════════════════════════════════════════════════════════════
// FLASHCARDS LIFECYCLE (LIFE-37..42)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "LIFE-37: Flashcard — Create",
  ignore: !HAS_INST,
  async fn() {
    const payload = TestData.flashcard(summaryId, keywordId);
    const r = await api.post("/flashcards", TOKEN, payload);
    assertStatus(r, 201);
    const fc = assertOk(r) as Record<string, unknown>;
    lifeFlashcardId = fc.id as string;
    assertEquals(fc.front, payload.front);
    track("flashcards", lifeFlashcardId);
  },
});

Deno.test({
  name: "LIFE-38: Flashcard — Update front text",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeFlashcardId, "lifeFlashcardId must be set");
    const newFront = `__e2e_front_updated_${Date.now()}__`;
    const r = await api.put(`/flashcards/${lifeFlashcardId}`, TOKEN, { front: newFront });
    assertStatus(r, 200);
    const fc = assertOk(r) as Record<string, unknown>;
    assertEquals(fc.front, newFront);
  },
});

Deno.test({
  name: "LIFE-39: Flashcard — Soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeFlashcardId, "lifeFlashcardId must be set");
    const r = await api.delete(`/flashcards/${lifeFlashcardId}`, TOKEN);
    assertStatus(r, 200);
    const fc = assertOk(r) as Record<string, unknown>;
    assert(fc.deleted_at !== null, "deleted_at must be set");
  },
});

Deno.test({
  name: "LIFE-40: Flashcard — Not visible in default list after soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeFlashcardId, "lifeFlashcardId must be set");
    const r = await api.get(`/flashcards?summary_id=${summaryId}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((f) => f.id === lifeFlashcardId);
    assert(!found, "soft-deleted flashcard must NOT appear in default list");
  },
});

Deno.test({
  name: "LIFE-41: Flashcard — Visible with include_deleted=true",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeFlashcardId, "lifeFlashcardId must be set");
    const r = await api.get(
      `/flashcards?summary_id=${summaryId}&include_deleted=true`,
      TOKEN,
    );
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((f) => f.id === lifeFlashcardId);
    assert(found, "soft-deleted flashcard must appear with include_deleted=true");
  },
});

Deno.test({
  name: "LIFE-42: Flashcard — Restore",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeFlashcardId, "lifeFlashcardId must be set");
    const r = await api.put(`/flashcards/${lifeFlashcardId}/restore`, TOKEN, {});
    assertStatus(r, 200);
    const fc = assertOk(r) as Record<string, unknown>;
    assertEquals(fc.deleted_at, null);
    assertEquals(fc.is_active, true);
  },
});

// ═══════════════════════════════════════════════════════════════════════
// QUIZ QUESTIONS LIFECYCLE (LIFE-43..48)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "LIFE-43: QuizQuestion — Create",
  ignore: !HAS_INST,
  async fn() {
    const payload = TestData.quizQuestion(summaryId, keywordId);
    const r = await api.post("/quiz-questions", TOKEN, payload);
    assertStatus(r, 201);
    const qq = assertOk(r) as Record<string, unknown>;
    lifeQuizQuestionId = qq.id as string;
    assertEquals(qq.question, payload.question);
    track("quiz-questions", lifeQuizQuestionId);
  },
});

Deno.test({
  name: "LIFE-44: QuizQuestion — Update question text",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeQuizQuestionId, "lifeQuizQuestionId must be set");
    const newQ = `__e2e_question_updated_${Date.now()}__`;
    const r = await api.put(`/quiz-questions/${lifeQuizQuestionId}`, TOKEN, { question: newQ });
    assertStatus(r, 200);
    const qq = assertOk(r) as Record<string, unknown>;
    assertEquals(qq.question, newQ);
  },
});

Deno.test({
  name: "LIFE-45: QuizQuestion — Soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeQuizQuestionId, "lifeQuizQuestionId must be set");
    const r = await api.delete(`/quiz-questions/${lifeQuizQuestionId}`, TOKEN);
    assertStatus(r, 200);
    const qq = assertOk(r) as Record<string, unknown>;
    assert(qq.deleted_at !== null, "deleted_at must be set");
  },
});

Deno.test({
  name: "LIFE-46: QuizQuestion — Not visible in default list after soft-delete",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeQuizQuestionId, "lifeQuizQuestionId must be set");
    const r = await api.get(`/quiz-questions?summary_id=${summaryId}`, TOKEN);
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((q) => q.id === lifeQuizQuestionId);
    assert(!found, "soft-deleted quiz-question must NOT appear in default list");
  },
});

Deno.test({
  name: "LIFE-47: QuizQuestion — Visible with include_deleted=true",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeQuizQuestionId, "lifeQuizQuestionId must be set");
    const r = await api.get(
      `/quiz-questions?summary_id=${summaryId}&include_deleted=true`,
      TOKEN,
    );
    assertStatus(r, 200);
    const body = assertOk(r) as Record<string, unknown>;
    const items = body.items as Record<string, unknown>[];
    const found = items.find((q) => q.id === lifeQuizQuestionId);
    assert(found, "soft-deleted quiz-question must appear with include_deleted=true");
  },
});

Deno.test({
  name: "LIFE-48: QuizQuestion — Restore",
  ignore: !HAS_INST,
  async fn() {
    assert(lifeQuizQuestionId, "lifeQuizQuestionId must be set");
    const r = await api.put(`/quiz-questions/${lifeQuizQuestionId}/restore`, TOKEN, {});
    assertStatus(r, 200);
    const qq = assertOk(r) as Record<string, unknown>;
    assertEquals(qq.deleted_at, null);
    assertEquals(qq.is_active, true);
  },
});

// ═══════════════════════════════════════════════════════════════════════
// FINAL CLEANUP (LIFE-99)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "LIFE-99: Cleanup — delete all created content in reverse order",
  ignore: !HAS_INST,
  async fn() {
    await cleanupAll(TOKEN);
    resetTracking();
  },
});
