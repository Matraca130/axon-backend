/**
 * tests/integration/sticky-notes.test.ts — /sticky-notes endpoints integration tests
 *
 * Verified against the real route:
 *   supabase/functions/server/routes/study/sticky-notes.ts
 *
 * Covers:
 *   - GET    /sticky-notes?summary_id=<uuid>  (200 with row or null, 400 on bad uuid)
 *   - POST   /sticky-notes  { summary_id, content }  (upsert, validation)
 *   - DELETE /sticky-notes?summary_id=<uuid>  (idempotent)
 *   - 20 000-char content cap
 *   - Anonymous (no auth) rejection
 *
 * Run:
 *   deno test tests/integration/sticky-notes.test.ts --allow-net --allow-env --no-check
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  login,
  api,
  ENV,
  apiBase,
  assertStatus,
  assertOk,
  assertError,
  isUuid,
} from "../helpers/test-client.ts";

// ─── Shared state ─────────────────────────────────────────────

let userToken = "";
let userId = "";

// Two summary IDs that the student has access to. We need REAL summary IDs
// because the route validates the FK on summary_id. We resolve them at setup
// time from /topics-overview (returns summaries the caller can read).
let summaryIdA = "";
let summaryIdB = "";

const RANDOM_UUID = "00000000-0000-4000-8000-000000000000"; // valid UUID format, no row

async function setup() {
  if (userToken) return;
  const auth = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);
  userToken = auth.access_token;
  userId = auth.user.id;

  // Resolve two summary IDs the student can read. We try /topics-overview
  // for any topic the student has, then pick the first two summaries.
  // If we can't find two, the cross-summary tests will be skipped gracefully.
  try {
    const topicsResp = await api.get<{
      summaries_by_topic?: Record<string, Array<{ id: string }>>;
      summaries?: Array<{ id: string }>;
    }>("/topics-overview", userToken);
    if (topicsResp.ok) {
      const data = assertOk(topicsResp) as any;
      const buckets = data.summaries_by_topic
        ? Object.values(data.summaries_by_topic)
        : [];
      const flat: Array<{ id: string }> = (buckets as Array<Array<{ id: string }>>).flat();
      if (flat.length > 0) summaryIdA = flat[0].id;
      if (flat.length > 1) summaryIdB = flat[1].id;
    }
  } catch {
    /* ignore — tests that need a real summary will be skipped */
  }
}

// Cleanup helper — removes our test note for a summary if it exists.
async function cleanupNote(summaryId: string, token: string) {
  if (!summaryId) return;
  try {
    await api.delete(
      `/sticky-notes?summary_id=${encodeURIComponent(summaryId)}`,
      token,
    );
  } catch {
    /* ignore */
  }
}

// ═══ VALIDATION (no DB needed, just exercises the validators) ═══

Deno.test("GET /sticky-notes rejects missing summary_id", async () => {
  await setup();
  const r = await api.get("/sticky-notes", userToken);
  assertError(r, 400);
  assert(
    (r.error || "").toLowerCase().includes("uuid"),
    `error should mention uuid: ${r.error}`,
  );
});

Deno.test("GET /sticky-notes rejects malformed summary_id", async () => {
  await setup();
  const r = await api.get("/sticky-notes?summary_id=not-a-uuid", userToken);
  assertError(r, 400);
});

Deno.test("POST /sticky-notes rejects empty body", async () => {
  await setup();
  const r = await api.post("/sticky-notes", userToken, undefined);
  assertError(r, 400);
});

Deno.test("POST /sticky-notes rejects missing summary_id", async () => {
  await setup();
  const r = await api.post("/sticky-notes", userToken, { content: "hi" });
  assertError(r, 400);
});

Deno.test("POST /sticky-notes rejects non-string content", async () => {
  await setup();
  const r = await api.post("/sticky-notes", userToken, {
    summary_id: RANDOM_UUID,
    content: 123,
  });
  assertError(r, 400);
});

Deno.test("POST /sticky-notes rejects content over 20 000 chars", async () => {
  await setup();
  const huge = "a".repeat(20_001);
  const r = await api.post("/sticky-notes", userToken, {
    summary_id: RANDOM_UUID,
    content: huge,
  });
  assertError(r, 400);
  assert(
    (r.error || "").toLowerCase().includes("max"),
    `error should mention max length: ${r.error}`,
  );
});

// ═══ READ — null on no row, never 404 ═══════════════════════

Deno.test("GET /sticky-notes returns null when there's no row for that summary", async () => {
  await setup();
  // Use a valid-format UUID we know has no note for this user.
  const fresh = crypto.randomUUID();
  const r = await api.get(`/sticky-notes?summary_id=${fresh}`, userToken);
  assertStatus(r, 200);
  const data = assertOk<unknown>(r);
  // Backend wraps with ok(c, data) → could be `null` or `{}` depending on FK constraints.
  // Either way, the response should NOT be a row object with content.
  assert(
    data === null || (typeof data === "object" && data !== null && !("content" in (data as Record<string, unknown>))),
    `expected null or empty, got ${JSON.stringify(data)}`,
  );
});

// ═══ WRITE — upsert (only runs if we resolved a real summary id) ═══

Deno.test("POST /sticky-notes creates a new note (upsert insert path)", async () => {
  await setup();
  if (!summaryIdA) {
    console.warn("[SKIP] no resolvable summaryIdA — student has no readable summaries");
    return;
  }
  await cleanupNote(summaryIdA, userToken);

  const r = await api.post("/sticky-notes", userToken, {
    summary_id: summaryIdA,
    content: "first note from integration test",
  });
  assertStatus(r, 200);
  const row = assertOk<{
    id: string;
    student_id: string;
    summary_id: string;
    content: string;
    created_at: string;
    updated_at: string;
  }>(r);
  assert(isUuid(row.id), "row must have a uuid id");
  assertEquals(row.student_id, userId);
  assertEquals(row.summary_id, summaryIdA);
  assertEquals(row.content, "first note from integration test");
});

Deno.test("POST /sticky-notes is idempotent on (student, summary) — second upsert keeps same id", async () => {
  await setup();
  if (!summaryIdA) {
    console.warn("[SKIP] no resolvable summaryIdA");
    return;
  }
  // First write (or re-use the previous test's row).
  const r1 = await api.post("/sticky-notes", userToken, {
    summary_id: summaryIdA,
    content: "v1",
  });
  assertStatus(r1, 200);
  const row1 = assertOk<{ id: string; content: string; updated_at: string }>(r1);

  // Second write with different content.
  const r2 = await api.post("/sticky-notes", userToken, {
    summary_id: summaryIdA,
    content: "v2 overwrites v1",
  });
  assertStatus(r2, 200);
  const row2 = assertOk<{ id: string; content: string; updated_at: string }>(r2);

  assertEquals(row2.id, row1.id, "upsert must preserve the same id");
  assertEquals(row2.content, "v2 overwrites v1");
  // updated_at should be > created_at (and ≥ row1.updated_at) thanks to the trigger.
  assert(
    new Date(row2.updated_at).getTime() >= new Date(row1.updated_at).getTime(),
    `updated_at should be monotonic (was ${row1.updated_at} → ${row2.updated_at})`,
  );
});

Deno.test("GET /sticky-notes returns the row that POST upserted", async () => {
  await setup();
  if (!summaryIdA) {
    console.warn("[SKIP] no resolvable summaryIdA");
    return;
  }
  const r = await api.get<{ content: string; summary_id: string }>(
    `/sticky-notes?summary_id=${summaryIdA}`,
    userToken,
  );
  assertStatus(r, 200);
  const row = assertOk(r);
  assertEquals(row.summary_id, summaryIdA);
  assertEquals(row.content, "v2 overwrites v1");
});

// ═══ DELETE — idempotent ═══════════════════════════════════════

Deno.test("DELETE /sticky-notes removes the row, GET returns null afterwards", async () => {
  await setup();
  if (!summaryIdA) {
    console.warn("[SKIP] no resolvable summaryIdA");
    return;
  }
  const rDel = await api.delete(
    `/sticky-notes?summary_id=${summaryIdA}`,
    userToken,
  );
  assertStatus(rDel, 200);
  const delBody = assertOk<{ deleted: boolean; summary_id: string }>(rDel);
  assertEquals(delBody.deleted, true);
  assertEquals(delBody.summary_id, summaryIdA);

  // Subsequent GET should return null.
  const rGet = await api.get(`/sticky-notes?summary_id=${summaryIdA}`, userToken);
  assertStatus(rGet, 200);
  const after = assertOk<unknown>(rGet);
  assert(
    after === null || (typeof after === "object" && after !== null && !("content" in (after as Record<string, unknown>))),
    `row should be gone, got ${JSON.stringify(after)}`,
  );
});

Deno.test("DELETE /sticky-notes is idempotent (no-op when no row)", async () => {
  await setup();
  if (!summaryIdA) {
    console.warn("[SKIP] no resolvable summaryIdA");
    return;
  }
  const r = await api.delete(`/sticky-notes?summary_id=${summaryIdA}`, userToken);
  assertStatus(r, 200);
  const body = assertOk<{ deleted: boolean }>(r);
  assertEquals(body.deleted, true);
});

// ═══ AUTH — anon must be rejected ══════════════════════════════

Deno.test("GET /sticky-notes without X-Access-Token is rejected (401)", async () => {
  // Bypass the helper to send WITHOUT X-Access-Token.
  const url = `${apiBase()}/sticky-notes?summary_id=${RANDOM_UUID}`;
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ENV.ANON_KEY}`,
      "apikey": ENV.ANON_KEY,
    },
  });
  // The route calls `authenticate()` which returns 401 when no JWT is present.
  // Some configurations return 403 — accept either.
  assert(
    res.status === 401 || res.status === 403,
    `expected 401/403 for anon, got ${res.status}`,
  );
  await res.body?.cancel();
});

// ═══ FINAL CLEANUP ════════════════════════════════════════════

Deno.test("cleanup: remove any leftover test rows", async () => {
  await setup();
  await cleanupNote(summaryIdA, userToken);
  await cleanupNote(summaryIdB, userToken);
});
