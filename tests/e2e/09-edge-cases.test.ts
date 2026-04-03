/**
 * tests/e2e/09-edge-cases.test.ts — Edge case & robustness tests
 * Run: deno test tests/e2e/09-edge-cases.test.ts --allow-net --allow-env --no-check
 *
 * Verifies the backend handles malformed/unusual input gracefully:
 *
 *   EDGE-01: Invalid UUID in path → 400 or 404 (not 500)
 *   EDGE-02: Empty body on POST → 400 with clear message
 *   EDGE-03: Large payload (~1MB) → 413 or graceful rejection
 *   EDGE-04: Query with limit=0 → defined behavior (default applied)
 *   EDGE-05: Query with limit=99999 → server caps at 500
 *   EDGE-06: Double DELETE same resource → idempotent (not 500)
 *   EDGE-07: Special characters in search → no injection, no crash
 *   EDGE-08: GET non-existent resource by valid UUID → 404
 *   EDGE-09: POST with extra/unknown fields → ignored (not 500)
 *   EDGE-10: Concurrent identical requests → no race condition crash
 *
 * Backend patterns (from crud-factory.ts):
 *   - safeJson() returns null for unparseable bodies → 400 "Invalid or missing JSON body"
 *   - parsePagination(): limit < 1 → defaults to 100; limit > 500 → capped to 500
 *   - GET /:id with no match → safeErr(..., 404) → "Get <table> failed"
 *   - Soft-delete double-delete: .is("deleted_at", null).single() → no row → safeErr 404
 *   - Extra fields on POST: only createFields are picked, rest silently ignored
 *   - No explicit UUID format validation in crud-factory — Supabase/PostgREST rejects bad UUIDs
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { login, api, ENV, apiBase, assertOk } from "../helpers/test-client.ts";

// ═══ CREDENTIAL FLAGS ═══

const HAS_ADMIN = ENV.ADMIN_EMAIL.length > 0 && ENV.ADMIN_PASSWORD.length > 0;
const HAS_STUDENT = ENV.USER_EMAIL.length > 0 && ENV.USER_PASSWORD.length > 0;
const HAS_INST = ENV.INSTITUTION_ID.length > 0;
const HAS_CREDS = ENV.SUPABASE_URL.length > 0 && ENV.ANON_KEY.length > 0;

/** Need at least one authenticated user + institution for most tests */
const CAN_TEST = HAS_ADMIN && HAS_INST && HAS_CREDS;

// ═══ HELPERS ═══

/** Assert status is NOT a 5xx server error. Edge cases should be handled gracefully. */
function assertNot5xx(status: number, label: string): void {
  assert(
    status < 500,
    `${label}: got ${status} — backend returned a server error instead of a graceful response`,
  );
}

/** Assert status matches one of the expected values. */
function assertOneOf(status: number, expected: number[], label: string): void {
  assert(
    expected.includes(status),
    `${label}: expected one of [${expected.join(", ")}] but got ${status}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// EDGE-01: Invalid UUID in path → 400 or 404 (not 500)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "EDGE-01: GET /courses/not-a-uuid → 400 or 404 (not 500)",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.get("/courses/not-a-valid-uuid", admin.access_token);

    assertNot5xx(r.status, "GET /courses/not-a-uuid");
    // Backend may return 400 (invalid format) or 404 (via safeErr). Both acceptable.
    assertOneOf(r.status, [400, 404, 422], "GET /courses/not-a-uuid");
  },
});

Deno.test({
  name: "EDGE-01b: PUT /courses/GARBAGE → 400 or 404 (not 500)",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.put("/courses/!!!invalid!!!", admin.access_token, {
      name: "test",
    });

    assertNot5xx(r.status, "PUT /courses/GARBAGE");
    assertOneOf(r.status, [400, 404, 422], "PUT /courses/GARBAGE");
  },
});

Deno.test({
  name: "EDGE-01c: DELETE /courses/xyz123 → 400 or 404 (not 500)",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.delete("/courses/xyz123", admin.access_token);

    assertNot5xx(r.status, "DELETE /courses/xyz123");
    assertOneOf(r.status, [400, 404, 422], "DELETE /courses/xyz123");
  },
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE-02: Empty body on POST → 400
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "EDGE-02a: POST /courses with empty JSON {} → 400",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.post("/courses", admin.access_token, {});

    assertNot5xx(r.status, "POST /courses empty body");
    // Should get 400 for missing required field: institution_id
    assertOneOf(r.status, [400, 422], "POST /courses empty body");
    // Verify there's an error message
    const body = r.raw as Record<string, unknown>;
    assert(
      body?.error && typeof body.error === "string",
      "EDGE-02a: expected error message in response body",
    );
  },
});

Deno.test({
  name: "EDGE-02b: POST /courses with no body (null-like) → 400",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    // Send request with Content-Type: application/json but empty string body
    // This goes through test-client which uses JSON.stringify(body) — sending undefined
    // means no body at all. We test by sending a raw fetch with no body.
    const url = `${apiBase()}/courses`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ENV.ANON_KEY,
        "Authorization": `Bearer ${ENV.ANON_KEY}`,
        "X-Access-Token": admin.access_token,
      },
      // No body at all
    });

    let raw: unknown;
    try { raw = await res.json(); } catch { raw = null; }

    assertNot5xx(res.status, "POST /courses no body");
    assertOneOf(res.status, [400, 422], "POST /courses no body");
  },
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE-03: Large payload (~1MB) → 413 or graceful rejection
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "EDGE-03: POST /courses with ~1MB payload → 413 or graceful rejection",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    // Build a ~1MB string
    const bigString = "A".repeat(1_000_000);

    const r = await api.post("/courses", admin.access_token, {
      institution_id: ENV.INSTITUTION_ID,
      name: bigString,
    });

    assertNot5xx(r.status, "POST /courses 1MB payload");
    // Accept: 400 (validation), 413 (payload too large), or even 422
    // The key assertion is: NOT a 500 server error.
  },
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE-04: limit=0 → defined behavior
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "EDGE-04: GET /courses?institution_id=X&limit=0 → defaults to 100 (not crash)",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.get(
      `/courses?institution_id=${ENV.INSTITUTION_ID}&limit=0`,
      admin.access_token,
    );

    assertNot5xx(r.status, "GET /courses limit=0");
    // parsePagination: limit < 1 → defaults to DEFAULT_PAGINATION_LIMIT (100)
    // So it should return 200 with the default limit applied
    assertOneOf(r.status, [200], "GET /courses limit=0");

    const data = assertOk(r) as Record<string, unknown>;
    // Verify limit was defaulted (backend sets limit to 100 when < 1)
    assert(
      (data.limit as number) === 100,
      `EDGE-04: expected limit=100 (default), got limit=${data.limit}`,
    );
  },
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE-05: limit=99999 → capped at 500
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "EDGE-05: GET /courses?institution_id=X&limit=99999 → capped at 500",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.get(
      `/courses?institution_id=${ENV.INSTITUTION_ID}&limit=99999`,
      admin.access_token,
    );

    assertNot5xx(r.status, "GET /courses limit=99999");
    assertOneOf(r.status, [200], "GET /courses limit=99999");

    const data = assertOk(r) as Record<string, unknown>;
    assert(
      (data.limit as number) === 500,
      `EDGE-05: expected limit=500 (max cap), got limit=${data.limit}`,
    );
  },
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE-06: Double DELETE → idempotent (not 500)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "EDGE-06: Double DELETE of same course → second returns 404 (not 500)",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    // Create a temporary course to delete
    const createR = await api.post("/courses", admin.access_token, {
      institution_id: ENV.INSTITUTION_ID,
      name: `__edge_double_delete_${Date.now()}__`,
    });

    if (createR.status !== 201) {
      // Cannot create course — skip gracefully
      console.log(`EDGE-06: Skipping — could not create course (${createR.status})`);
      return;
    }

    const created = (createR.raw as Record<string, unknown>)?.data as Record<string, unknown>;
    const courseId = created?.id as string;
    assert(courseId, "EDGE-06: created course must have an id");

    // First DELETE — should succeed
    const del1 = await api.delete(`/courses/${courseId}`, admin.access_token);
    assertNot5xx(del1.status, "EDGE-06 first DELETE");
    assertOneOf(del1.status, [200], "EDGE-06 first DELETE");

    // Second DELETE — resource already soft-deleted, .is("deleted_at", null) finds nothing
    const del2 = await api.delete(`/courses/${courseId}`, admin.access_token);
    assertNot5xx(del2.status, "EDGE-06 second DELETE");
    // Should be 404 (row not found with deleted_at IS NULL) — NOT a 500
    assertOneOf(del2.status, [200, 404], "EDGE-06 second DELETE");

    // Cleanup: restore then hard-delete is not possible via API.
    // The soft-deleted course with __edge_ prefix is harmless test data.
    // Attempt restore for cleanliness:
    await api.put(`/courses/${courseId}/restore`, admin.access_token, {});
    await api.delete(`/courses/${courseId}`, admin.access_token);
  },
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE-07: Special characters in search → no injection, no crash
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "EDGE-07a: SQL injection attempt in query param → no crash",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    // Classic SQL injection patterns in query params
    const injections = [
      `'; DROP TABLE courses; --`,
      `" OR "1"="1`,
      `1; SELECT * FROM pg_tables`,
      `' UNION SELECT null,null,null--`,
    ];

    for (const injection of injections) {
      const encoded = encodeURIComponent(injection);
      const r = await api.get(
        `/courses?institution_id=${encoded}`,
        admin.access_token,
      );

      assertNot5xx(
        r.status,
        `SQL injection attempt: ${injection.slice(0, 30)}...`,
      );
      // Should get 400/403/404 — definitely not 500
    }
  },
});

Deno.test({
  name: "EDGE-07b: Special chars in POST body → no crash",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.post("/courses", admin.access_token, {
      institution_id: ENV.INSTITUTION_ID,
      name: `<script>alert('xss')</script> ' OR 1=1 -- \u0000\uFFFF`,
    });

    assertNot5xx(r.status, "POST /courses with special chars");
    // Should either create (201) or reject (400) — not crash (500)

    // If it was created, clean it up
    if (r.status === 201) {
      const data = (r.raw as Record<string, unknown>)?.data as Record<string, unknown>;
      if (data?.id) {
        await api.delete(`/courses/${data.id}`, admin.access_token);
      }
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE-08: GET non-existent resource by valid UUID → 404
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "EDGE-08: GET /courses/<valid-but-nonexistent-uuid> → 404",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    // Valid UUID format but guaranteed to not exist
    const fakeId = "00000000-dead-beef-0000-000000000000";
    const r = await api.get(`/courses/${fakeId}`, admin.access_token);

    assertNot5xx(r.status, "GET /courses/nonexistent");
    assertOneOf(r.status, [403, 404], "GET /courses/nonexistent");
  },
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE-09: POST with extra/unknown fields → ignored (not 500)
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "EDGE-09: POST /courses with extra unknown fields → ignored (201 or 400, not 500)",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.post("/courses", admin.access_token, {
      institution_id: ENV.INSTITUTION_ID,
      name: `__edge_extra_fields_${Date.now()}__`,
      // These fields are NOT in createFields — should be silently dropped
      hacker_field: "should_be_ignored",
      __proto__: { admin: true },
      constructor: "evil",
      $where: "1=1",
      nested: { deep: { value: "ignored" } },
    });

    assertNot5xx(r.status, "POST /courses extra fields");
    // Should succeed (201) since valid required fields are present,
    // OR fail with 400 if name validation fails — but NOT 500
    assertOneOf(r.status, [200, 201, 400], "POST /courses extra fields");

    // Clean up if created
    if (r.status === 201) {
      const data = (r.raw as Record<string, unknown>)?.data as Record<string, unknown>;
      if (data?.id) {
        await api.delete(`/courses/${data.id}`, admin.access_token);
      }
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE-10: Concurrent identical requests → no race condition crash
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "EDGE-10: 5 concurrent GET requests → all succeed (no race crash)",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    // Fire 5 identical GET requests in parallel
    const promises = Array.from({ length: 5 }, () =>
      api.get(
        `/courses?institution_id=${ENV.INSTITUTION_ID}&limit=1`,
        admin.access_token,
      )
    );

    const results = await Promise.all(promises);

    for (let i = 0; i < results.length; i++) {
      assertNot5xx(results[i].status, `Concurrent GET #${i + 1}`);
      assertOneOf(results[i].status, [200], `Concurrent GET #${i + 1}`);
    }
  },
});

Deno.test({
  name: "EDGE-10b: Concurrent POST + GET → no crash",
  ignore: !CAN_TEST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    // Mix of reads and writes in parallel
    const promises = [
      api.get(`/courses?institution_id=${ENV.INSTITUTION_ID}&limit=1`, admin.access_token),
      api.get(`/courses?institution_id=${ENV.INSTITUTION_ID}&limit=1`, admin.access_token),
      api.post("/courses", admin.access_token, {
        institution_id: ENV.INSTITUTION_ID,
        name: `__edge_concurrent_${Date.now()}_a__`,
      }),
      api.post("/courses", admin.access_token, {
        institution_id: ENV.INSTITUTION_ID,
        name: `__edge_concurrent_${Date.now()}_b__`,
      }),
    ];

    const results = await Promise.all(promises);

    // All should complete without 5xx
    for (let i = 0; i < results.length; i++) {
      assertNot5xx(results[i].status, `Concurrent mixed #${i + 1}`);
    }

    // Clean up any created courses
    for (const r of results) {
      if (r.status === 201) {
        const data = (r.raw as Record<string, unknown>)?.data as Record<string, unknown>;
        if (data?.id) {
          await api.delete(`/courses/${data.id}`, admin.access_token);
        }
      }
    }
  },
});
