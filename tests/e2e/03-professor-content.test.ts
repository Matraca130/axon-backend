/**
 * tests/e2e/03-professor-content.test.ts — Professor content tree CRUD
 * Run: deno test tests/e2e/03-professor-content.test.ts --allow-net --allow-env --no-check
 *
 * Tests the full content hierarchy:
 *   CONTENT-01: POST /courses → create test course
 *   CONTENT-02: GET /courses?institution_id=X → verify course appears
 *   CONTENT-03: POST /semesters → create under course
 *   CONTENT-04: GET /semesters?course_id=X → verify semester appears
 *   CONTENT-05: POST /sections → create under semester
 *   CONTENT-06: GET /sections?semester_id=X → verify section appears
 *   CONTENT-07: POST /topics → create under section
 *   CONTENT-08: GET /topics?section_id=X → verify topic appears
 *   CONTENT-09: POST /summaries → create under topic
 *   CONTENT-10: GET /summaries?topic_id=X → verify summary appears
 *   CONTENT-11: POST /keywords → create under summary
 *   CONTENT-12: GET /keywords?summary_id=X → verify keyword appears
 *   CONTENT-13: GET /content-tree?institution_id=X → verify full tree
 *   CONTENT-14: Cleanup — soft-delete everything in reverse order
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { login, api, ENV, assertStatus, assertOk } from "../helpers/test-client.ts";
import { TestData } from "./fixtures/test-data-factory.ts";
import { track, cleanupAll, resetTracking } from "./helpers/cleanup.ts";

// ═══ Prerequisites ═══

/** True when admin credentials are configured */
const HAS_CREDS = ENV.ADMIN_EMAIL.length > 0 && ENV.ADMIN_PASSWORD.length > 0;

/** True when institution ID is configured */
const HAS_INST = HAS_CREDS && ENV.INSTITUTION_ID.length > 0;

// ═══ Shared state across sequential tests ═══
// Deno.test runs in declaration order within a file, so we can share IDs.

let TOKEN = "";
let courseId = "";
let semesterId = "";
let sectionId = "";
let topicId = "";
let summaryId = "";
let keywordId = "";

// ═══ 0. Login once ═══

Deno.test({
  name: "CONTENT-00: Login as admin/professor for content tests",
  ignore: !HAS_CREDS,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);
    TOKEN = access_token;
    assert(TOKEN.length > 0, "must obtain access token");
    resetTracking();
  },
});

// ═══ 1. POST /courses → CREATE COURSE ═══

Deno.test({
  name: "CONTENT-01: POST /courses creates a test course",
  ignore: !HAS_INST,
  async fn() {
    const payload = TestData.course(ENV.INSTITUTION_ID);

    const r = await api.post("/courses", TOKEN, payload);
    assertStatus(r, 201);

    const course = assertOk(r) as Record<string, unknown>;
    assert(typeof course.id === "string", "course must have id");
    assertEquals(course.name, payload.name, "course name must match");
    assertEquals(course.institution_id, ENV.INSTITUTION_ID, "institution_id must match");

    courseId = course.id as string;
    track("courses", courseId);
  },
});

// ═══ 2. GET /courses → VERIFY COURSE IN LIST ═══

Deno.test({
  name: "CONTENT-02: GET /courses?institution_id=X lists the created course",
  ignore: !HAS_INST,
  async fn() {
    assert(courseId.length > 0, "courseId must be set from CONTENT-01");

    const r = await api.get(`/courses?institution_id=${ENV.INSTITUTION_ID}`, TOKEN);
    assertStatus(r, 200);

    const body = assertOk(r) as Record<string, unknown>;
    assert(Array.isArray(body.items), "courses response must have items array");

    const items = body.items as Record<string, unknown>[];
    const found = items.find((c) => c.id === courseId);
    assert(found, `created course ${courseId} must appear in list`);
  },
});

// ═══ 3. POST /semesters → CREATE SEMESTER ═══

Deno.test({
  name: "CONTENT-03: POST /semesters creates a semester under the course",
  ignore: !HAS_INST,
  async fn() {
    assert(courseId.length > 0, "courseId must be set from CONTENT-01");

    const payload = TestData.semester(courseId);

    const r = await api.post("/semesters", TOKEN, payload);
    assertStatus(r, 201);

    const semester = assertOk(r) as Record<string, unknown>;
    assert(typeof semester.id === "string", "semester must have id");
    assertEquals(semester.name, payload.name, "semester name must match");
    assertEquals(semester.course_id, courseId, "course_id must match");

    semesterId = semester.id as string;
    track("semesters", semesterId);
  },
});

// ═══ 4. GET /semesters → VERIFY SEMESTER IN LIST ═══

Deno.test({
  name: "CONTENT-04: GET /semesters?course_id=X lists the created semester",
  ignore: !HAS_INST,
  async fn() {
    assert(semesterId.length > 0, "semesterId must be set from CONTENT-03");

    const r = await api.get(`/semesters?course_id=${courseId}`, TOKEN);
    assertStatus(r, 200);

    const body = assertOk(r) as Record<string, unknown>;
    assert(Array.isArray(body.items), "semesters response must have items array");

    const items = body.items as Record<string, unknown>[];
    const found = items.find((s) => s.id === semesterId);
    assert(found, `created semester ${semesterId} must appear in list`);
  },
});

// ═══ 5. POST /sections → CREATE SECTION ═══

Deno.test({
  name: "CONTENT-05: POST /sections creates a section under the semester",
  ignore: !HAS_INST,
  async fn() {
    assert(semesterId.length > 0, "semesterId must be set from CONTENT-03");

    const payload = TestData.section(semesterId);

    const r = await api.post("/sections", TOKEN, payload);
    assertStatus(r, 201);

    const section = assertOk(r) as Record<string, unknown>;
    assert(typeof section.id === "string", "section must have id");
    assertEquals(section.name, payload.name, "section name must match");
    assertEquals(section.semester_id, semesterId, "semester_id must match");

    sectionId = section.id as string;
    track("sections", sectionId);
  },
});

// ═══ 6. GET /sections → VERIFY SECTION IN LIST ═══

Deno.test({
  name: "CONTENT-06: GET /sections?semester_id=X lists the created section",
  ignore: !HAS_INST,
  async fn() {
    assert(sectionId.length > 0, "sectionId must be set from CONTENT-05");

    const r = await api.get(`/sections?semester_id=${semesterId}`, TOKEN);
    assertStatus(r, 200);

    const body = assertOk(r) as Record<string, unknown>;
    assert(Array.isArray(body.items), "sections response must have items array");

    const items = body.items as Record<string, unknown>[];
    const found = items.find((s) => s.id === sectionId);
    assert(found, `created section ${sectionId} must appear in list`);
  },
});

// ═══ 7. POST /topics → CREATE TOPIC ═══

Deno.test({
  name: "CONTENT-07: POST /topics creates a topic under the section",
  ignore: !HAS_INST,
  async fn() {
    assert(sectionId.length > 0, "sectionId must be set from CONTENT-05");

    const payload = TestData.topic(sectionId);

    const r = await api.post("/topics", TOKEN, payload);
    assertStatus(r, 201);

    const topic = assertOk(r) as Record<string, unknown>;
    assert(typeof topic.id === "string", "topic must have id");
    assertEquals(topic.name, payload.name, "topic name must match");
    assertEquals(topic.section_id, sectionId, "section_id must match");

    topicId = topic.id as string;
    track("topics", topicId);
  },
});

// ═══ 8. GET /topics → VERIFY TOPIC IN LIST ═══

Deno.test({
  name: "CONTENT-08: GET /topics?section_id=X lists the created topic",
  ignore: !HAS_INST,
  async fn() {
    assert(topicId.length > 0, "topicId must be set from CONTENT-07");

    const r = await api.get(`/topics?section_id=${sectionId}`, TOKEN);
    assertStatus(r, 200);

    const body = assertOk(r) as Record<string, unknown>;
    assert(Array.isArray(body.items), "topics response must have items array");

    const items = body.items as Record<string, unknown>[];
    const found = items.find((t) => t.id === topicId);
    assert(found, `created topic ${topicId} must appear in list`);
  },
});

// ═══ 9. POST /summaries → CREATE SUMMARY ═══

Deno.test({
  name: "CONTENT-09: POST /summaries creates a summary under the topic",
  ignore: !HAS_INST,
  async fn() {
    assert(topicId.length > 0, "topicId must be set from CONTENT-07");

    const payload = TestData.summary(topicId);

    const r = await api.post("/summaries", TOKEN, payload);
    assertStatus(r, 201);

    const summary = assertOk(r) as Record<string, unknown>;
    assert(typeof summary.id === "string", "summary must have id");
    assertEquals(summary.title, payload.title, "summary title must match");
    assertEquals(summary.topic_id, topicId, "topic_id must match");

    summaryId = summary.id as string;
    track("summaries", summaryId);
  },
});

// ═══ 10. GET /summaries → VERIFY SUMMARY IN LIST ═══

Deno.test({
  name: "CONTENT-10: GET /summaries?topic_id=X lists the created summary",
  ignore: !HAS_INST,
  async fn() {
    assert(summaryId.length > 0, "summaryId must be set from CONTENT-09");

    const r = await api.get(`/summaries?topic_id=${topicId}`, TOKEN);
    assertStatus(r, 200);

    const body = assertOk(r) as Record<string, unknown>;
    assert(Array.isArray(body.items), "summaries response must have items array");

    const items = body.items as Record<string, unknown>[];
    const found = items.find((s) => s.id === summaryId);
    assert(found, `created summary ${summaryId} must appear in list`);
  },
});

// ═══ 11. POST /keywords → CREATE KEYWORD ═══

Deno.test({
  name: "CONTENT-11: POST /keywords creates a keyword under the summary",
  ignore: !HAS_INST,
  async fn() {
    assert(summaryId.length > 0, "summaryId must be set from CONTENT-09");

    const payload = TestData.keyword(summaryId);

    const r = await api.post("/keywords", TOKEN, payload);
    assertStatus(r, 201);

    const keyword = assertOk(r) as Record<string, unknown>;
    assert(typeof keyword.id === "string", "keyword must have id");
    assertEquals(keyword.name, payload.name, "keyword name must match");
    assertEquals(keyword.summary_id, summaryId, "summary_id must match");

    keywordId = keyword.id as string;
    track("keywords", keywordId);
  },
});

// ═══ 12. GET /keywords → VERIFY KEYWORD IN LIST ═══

Deno.test({
  name: "CONTENT-12: GET /keywords?summary_id=X lists the created keyword",
  ignore: !HAS_INST,
  async fn() {
    assert(keywordId.length > 0, "keywordId must be set from CONTENT-11");

    const r = await api.get(`/keywords?summary_id=${summaryId}`, TOKEN);
    assertStatus(r, 200);

    const body = assertOk(r) as Record<string, unknown>;
    assert(Array.isArray(body.items), "keywords response must have items array");

    const items = body.items as Record<string, unknown>[];
    const found = items.find((k) => k.id === keywordId);
    assert(found, `created keyword ${keywordId} must appear in list`);
  },
});

// ═══ 13. GET /content-tree → VERIFY FULL TREE ═══

Deno.test({
  name: "CONTENT-13: GET /content-tree?institution_id=X returns nested hierarchy",
  ignore: !HAS_INST,
  async fn() {
    const r = await api.get(`/content-tree?institution_id=${ENV.INSTITUTION_ID}`, TOKEN);
    assertStatus(r, 200);

    const tree = assertOk(r) as Record<string, unknown>[];
    assert(Array.isArray(tree), "content-tree must return an array of courses");

    // Find our test course in the tree
    const course = tree.find((c) => c.id === courseId);
    assert(course, `test course ${courseId} must appear in content-tree`);

    // Verify nested structure exists
    const semesters = course.semesters as Record<string, unknown>[];
    assert(Array.isArray(semesters), "course must have semesters array");
    assert(semesters.length > 0, "course must have at least one semester");

    const semester = semesters.find((s) => s.id === semesterId);
    assert(semester, `test semester ${semesterId} must appear in tree`);

    const sections = semester.sections as Record<string, unknown>[];
    assert(Array.isArray(sections), "semester must have sections array");
    assert(sections.length > 0, "semester must have at least one section");

    const section = sections.find((s) => s.id === sectionId);
    assert(section, `test section ${sectionId} must appear in tree`);

    const topics = section.topics as Record<string, unknown>[];
    assert(Array.isArray(topics), "section must have topics array");
    assert(topics.length > 0, "section must have at least one topic");

    const topic = topics.find((t) => t.id === topicId);
    assert(topic, `test topic ${topicId} must appear in tree`);
  },
});

// ═══ 14. Cleanup — soft-delete everything in reverse order ═══

Deno.test({
  name: "CONTENT-14: Cleanup — delete all created content in reverse order",
  ignore: !HAS_INST,
  async fn() {
    // cleanupAll deletes in LIFO order (keywords first, then summaries, topics, etc.)
    await cleanupAll(TOKEN);

    // Verify course was deleted (soft-delete sets is_active=false or returns 404)
    if (courseId) {
      const r = await api.get(`/courses/${courseId}`, TOKEN);
      // After soft-delete: either 404 or returned with is_active=false
      assert(
        r.status === 404 || r.status === 200,
        `GET after DELETE should return 404 or 200, got ${r.status}`,
      );
      if (r.status === 200) {
        const course = assertOk(r) as Record<string, unknown>;
        assertEquals(course.is_active, false, "course must be soft-deleted (is_active=false)");
      }
    }

    resetTracking();
  },
});
