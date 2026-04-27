/**
 * tests/integration/crud-factory.test.ts — CRUD integration tests
 * Verified against REAL crud-factory.ts, index.ts, content-tree.ts, routes/content/crud.ts.
 *
 * Run: deno test tests/integration/crud-factory.test.ts --allow-net --allow-env --no-check
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { login, api, ENV, assertStatus, assertOk, assertError } from "../helpers/test-client.ts";

let adminToken: string;
async function setup() {
  if (adminToken) return;
  adminToken = (await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD)).access_token;
}

// ═══ HEALTH CHECK (uses c.json() directly, NOT ok() wrapper) ═══

Deno.test("health returns status ok", async () => {
  await setup();
  const r = await api.get("/health", adminToken);
  assertStatus(r, 200);
  // NOTE: /health uses c.json() directly, NOT ok(). So r.raw has NO { data: ... } wrapper.
  assertEquals((r.raw as any).status, "ok");
  // #678: /health must NOT leak version or which integrations are configured.
  assertEquals((r.raw as any).version, undefined);
  assertEquals((r.raw as any).services, undefined);
});

// ═══ LIST OPERATIONS ═══

// Contract: every crud-factory LIST endpoint returns { items, total, limit, offset }
// wrapped in the { data: ... } envelope. See README.md § Response Patterns and
// crud-factory.ts:301. Freezing this shape here catches any regression that would
// silently break typed frontend clients (BH-ERR-017 / 018 / 020).
function assertPaginatedShape(d: unknown): asserts d is { items: unknown[]; total: number; limit: number; offset: number } {
  const v = d as { items?: unknown; total?: unknown; limit?: unknown; offset?: unknown };
  assert(Array.isArray(v.items), "items must be an array");
  assert(typeof v.total === "number", "total must be a number");
  assert(typeof v.limit === "number", "limit must be a number");
  assert(typeof v.offset === "number", "offset must be a number");
}

// Resolve a full content chain (course → semester → section → topic → summary)
// from the test institution. Memoised so shape tests don't re-fetch.
let resolvedChain: { courseId?: string; semesterId?: string; sectionId?: string; topicId?: string; summaryId?: string } | null = null;
async function resolveChain() {
  if (resolvedChain) return resolvedChain;
  resolvedChain = {};
  const cr = await api.get<{items:Array<{id:string}>}>(`/courses?institution_id=${ENV.INSTITUTION_ID}`, adminToken);
  if (!cr.ok || !assertOk(cr).items.length) return resolvedChain;
  resolvedChain.courseId = assertOk(cr).items[0].id;

  const sr = await api.get<{items:Array<{id:string}>}>(`/semesters?course_id=${resolvedChain.courseId}`, adminToken);
  if (!sr.ok || !assertOk(sr).items.length) return resolvedChain;
  resolvedChain.semesterId = assertOk(sr).items[0].id;

  const secr = await api.get<{items:Array<{id:string}>}>(`/sections?semester_id=${resolvedChain.semesterId}`, adminToken);
  if (!secr.ok || !assertOk(secr).items.length) return resolvedChain;
  resolvedChain.sectionId = assertOk(secr).items[0].id;

  const tr = await api.get<{items:Array<{id:string}>}>(`/topics?section_id=${resolvedChain.sectionId}`, adminToken);
  if (!tr.ok || !assertOk(tr).items.length) return resolvedChain;
  resolvedChain.topicId = assertOk(tr).items[0].id;

  const smr = await api.get<{items:Array<{id:string}>}>(`/summaries?topic_id=${resolvedChain.topicId}`, adminToken);
  if (!smr.ok || !assertOk(smr).items.length) return resolvedChain;
  resolvedChain.summaryId = assertOk(smr).items[0].id;

  return resolvedChain;
}

Deno.test("LIST courses returns paginated {items, total, limit, offset}", async () => {
  await setup();
  const r = await api.get(`/courses?institution_id=${ENV.INSTITUTION_ID}`, adminToken);
  assertStatus(r, 200);
  assertPaginatedShape(assertOk(r));
});

Deno.test("LIST summaries returns paginated {items, total, limit, offset}", async () => {
  await setup();
  const chain = await resolveChain();
  if (!chain.topicId) { console.warn("[SKIP] No topic in test institution"); return; }
  const r = await api.get(`/summaries?topic_id=${chain.topicId}`, adminToken);
  assertStatus(r, 200);
  assertPaginatedShape(assertOk(r));
});

Deno.test("LIST keywords returns paginated {items, total, limit, offset}", async () => {
  await setup();
  const chain = await resolveChain();
  if (!chain.summaryId) { console.warn("[SKIP] No summary in test institution"); return; }
  const r = await api.get(`/keywords?summary_id=${chain.summaryId}`, adminToken);
  assertStatus(r, 200);
  assertPaginatedShape(assertOk(r));
});

Deno.test("content-tree returns nested array with course structure", async () => {
  await setup();
  const r = await api.get(`/content-tree?institution_id=${ENV.INSTITUTION_ID}`, adminToken);
  assertStatus(r, 200);
  // content-tree.ts uses ok(c, filterActiveTree(data)) so assertOk unwraps correctly
  const d = assertOk(r) as unknown[];
  assert(Array.isArray(d), "content-tree must return an array");
  // Verify nested structure if data exists
  if (d.length > 0) {
    const course = d[0] as Record<string, unknown>;
    assert("id" in course, "course must have id");
    assert("name" in course, "course must have name");
    assert("semesters" in course, "course must have nested semesters");
    assert(Array.isArray(course.semesters), "semesters must be an array");
  }
});

// ═══ MISSING REQUIRED PARAMS ═══
// crud-factory.ts: if (!parentValue) return err(c, `Missing required query param: ${cfg.parentKey}`, 400)

Deno.test("topics without section_id returns 400", async () => {
  await setup();
  assertError(await api.get("/topics", adminToken), 400);
});

Deno.test("summaries without topic_id returns 400", async () => {
  await setup();
  assertError(await api.get("/summaries", adminToken), 400);
});

Deno.test("flashcards without summary_id returns 400", async () => {
  await setup();
  assertError(await api.get("/flashcards", adminToken), 400);
});

// ═══ INVALID ID ═══

Deno.test("GET invalid UUID returns 404 or 400", async () => {
  await setup();
  const r = await api.get("/courses/not-a-uuid", adminToken);
  assert(r.status === 404 || r.status === 400, `Expected 404 or 400, got ${r.status}`);
});

// ═══ PAGINATION (verified: DEFAULT=100, MAX=500, negative offset -> 0) ═══

Deno.test("pagination limit capped at 500 (N-9 FIX)", async () => {
  await setup();
  const r = await api.get<{limit:number}>(`/courses?institution_id=${ENV.INSTITUTION_ID}&limit=9999`, adminToken);
  assertStatus(r, 200);
  assertEquals(assertOk(r).limit, 500, "limit must be capped at MAX_PAGINATION_LIMIT=500");
});

Deno.test("default pagination limit is 100 when no limit param", async () => {
  await setup();
  const r = await api.get<{limit:number}>(`/courses?institution_id=${ENV.INSTITUTION_ID}`, adminToken);
  assertStatus(r, 200);
  assertEquals(assertOk(r).limit, 100, "default limit must be DEFAULT_PAGINATION_LIMIT=100");
});

Deno.test("negative offset corrected to 0", async () => {
  await setup();
  const r = await api.get<{offset:number}>(`/courses?institution_id=${ENV.INSTITUTION_ID}&offset=-5`, adminToken);
  assertStatus(r, 200);
  assertEquals(assertOk(r).offset, 0);
});

// ═══ 404 CATCH-ALL (uses c.json() directly, NOT ok()) ═══

Deno.test("404 catch-all for unknown route", async () => {
  await setup();
  const r = await api.get("/nonexistent", adminToken);
  assertStatus(r, 404);
  // NOTE: 404 handler uses c.json() directly, NOT ok(). No { data: ... } wrapper.
  assertEquals((r.raw as any).error, "Route not found");
  assert("path" in (r.raw as any), "404 response should include path");
  assert("method" in (r.raw as any), "404 response should include method");
});

// ═══ AUTH ═══

Deno.test("no auth token returns 401", async () => {
  const r = await api.get("/courses?institution_id=" + ENV.INSTITUTION_ID, "");
  assert(r.status === 401 || r.status === 403, `Expected 401/403, got ${r.status}`);
});

// ═══ CRUD LIFECYCLE: POST -> PUT -> DELETE -> RESTORE ═══
// Tests the full crud-factory lifecycle for a soft-delete table.
// Requires admin with CONTENT_WRITE_ROLES in TEST_INSTITUTION_ID.

let createdTopicId: string | null = null;
let testSectionId: string | null = null;

Deno.test("LIFECYCLE: find a section_id for topic creation", async () => {
  await setup();
  // Get courses -> first course -> first semester -> first section
  const cr = await api.get<{items:any[]}>(`/courses?institution_id=${ENV.INSTITUTION_ID}`, adminToken);
  if (!cr.ok) { console.warn("[SKIP] No courses found"); return; }
  const courses = assertOk(cr).items;
  if (!courses.length) { console.warn("[SKIP] No courses"); return; }

  const sr = await api.get<{items:any[]}>(`/semesters?course_id=${courses[0].id}`, adminToken);
  if (!sr.ok || !assertOk(sr).items.length) { console.warn("[SKIP] No semesters"); return; }

  const secr = await api.get<{items:any[]}>(`/sections?semester_id=${assertOk(sr).items[0].id}`, adminToken);
  if (!secr.ok || !assertOk(secr).items.length) { console.warn("[SKIP] No sections"); return; }
  testSectionId = assertOk(secr).items[0].id;
});

Deno.test("LIFECYCLE: POST creates topic", async () => {
  await setup();
  if (!testSectionId) { console.warn("[SKIP] No section_id"); return; }
  const r = await api.post("/topics", adminToken, {
    section_id: testSectionId, name: "__test_topic_audit5__",
  });
  assert(r.status === 201, `Expected 201, got ${r.status}: ${r.error}`);
  createdTopicId = (assertOk(r) as any).id;
  assert(typeof createdTopicId === "string", "created topic must have id");
});

Deno.test("LIFECYCLE: PUT renames topic", async () => {
  await setup();
  if (!createdTopicId) { console.warn("[SKIP] No topic created"); return; }
  const r = await api.put(`/topics/${createdTopicId}`, adminToken, {
    name: "__test_topic_renamed__",
  });
  assertStatus(r, 200);
  assertEquals((assertOk(r) as any).name, "__test_topic_renamed__");
});

Deno.test("LIFECYCLE: DELETE soft-deletes topic", async () => {
  await setup();
  if (!createdTopicId) { console.warn("[SKIP] No topic created"); return; }
  const r = await api.delete(`/topics/${createdTopicId}`, adminToken);
  assertStatus(r, 200);
  const d = assertOk(r) as any;
  assert(d.deleted_at !== null, "soft-deleted topic must have deleted_at");
});
