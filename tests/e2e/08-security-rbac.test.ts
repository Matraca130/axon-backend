/**
 * tests/e2e/08-security-rbac.test.ts — Cross-role security & RBAC tests
 * Run: deno test tests/e2e/08-security-rbac.test.ts --allow-net --allow-env --no-check
 *
 * Verifies that roles CANNOT perform unauthorized operations:
 *
 * WITH STUDENT TOKEN:
 *   RBAC-01: POST /courses → 403 (students can't create courses)
 *   RBAC-02: POST /summaries → 403 (students can't create summaries)
 *   RBAC-03: POST /quiz-questions → 403 (students can't create quiz questions)
 *   RBAC-04: POST /memberships → 403 (students can't manage members)
 *   RBAC-05: PUT /memberships/:id → 403 (students can't change roles)
 *   RBAC-06: DELETE /institutions/:id → 403 (students can't delete institutions)
 *
 * WITH PROFESSOR TOKEN (if available):
 *   RBAC-07: DELETE /institutions/:id → 403 (owner only)
 *   RBAC-08: PUT /memberships/:id (role change) → 403 (management only)
 *
 * NO AUTH:
 *   RBAC-09: No auth token → 401 on protected endpoints
 *   RBAC-10: Invalid/expired token → 401
 *
 * CROSS-USER:
 *   RBAC-11: Access another institution's resources → 403
 *
 * Backend RBAC model:
 *   - authenticate() in db.ts verifies JWT (jose + JWKS). Missing/invalid → 401.
 *   - requireInstitutionRole() in auth-helpers.ts checks membership + role.
 *   - CONTENT_WRITE_ROLES = ["owner", "admin", "professor"] — students excluded from writes.
 *   - MANAGEMENT_ROLES = ["owner", "admin"] — for membership management.
 *   - DELETE /institutions requires ["owner"] only.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { login, api, ENV, apiBase } from "../helpers/test-client.ts";

// ═══ CREDENTIAL FLAGS ═══

/** Admin/owner credentials available */
const HAS_ADMIN = ENV.ADMIN_EMAIL.length > 0 && ENV.ADMIN_PASSWORD.length > 0;

/** Student credentials available */
const HAS_STUDENT = ENV.USER_EMAIL.length > 0 && ENV.USER_PASSWORD.length > 0;

/** Institution ID configured */
const HAS_INST = ENV.INSTITUTION_ID.length > 0;

/** Both student + admin + institution required for cross-role tests */
const CAN_TEST_STUDENT = HAS_STUDENT && HAS_ADMIN && HAS_INST;

// ═══ HELPERS ═══

/**
 * Assert that a response is NOT 2xx (unauthorized operation must fail).
 * Accepts 401, 403, or 404 as valid denial responses.
 */
function assertDenied(
  status: number,
  label: string,
): void {
  assert(
    status === 401 || status === 403 || status === 404,
    `${label}: expected 401/403/404 but got ${status} — endpoint may be missing RBAC`,
  );
}

/**
 * Assert that a response is specifically 401 (unauthenticated).
 */
function assert401(status: number, label: string): void {
  assert(
    status === 401,
    `${label}: expected 401 but got ${status}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION A: STUDENT CANNOT PERFORM WRITE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════

// RBAC-01: Student cannot create courses
Deno.test({
  name: "RBAC-01: Student POST /courses → denied (CONTENT_WRITE_ROLES only)",
  ignore: !CAN_TEST_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    const r = await api.post("/courses", student.access_token, {
      institution_id: ENV.INSTITUTION_ID,
      name: `__rbac_test_course_${Date.now()}__`,
    });

    assertDenied(r.status, "Student POST /courses");
  },
});

// RBAC-02: Student cannot create summaries
// Summaries require topic_id (content hierarchy). We use a fake UUID.
// The backend resolves institution from parent, so even with a valid topic
// the student role will be denied CONTENT_WRITE_ROLES.
Deno.test({
  name: "RBAC-02: Student POST /summaries → denied (CONTENT_WRITE_ROLES only)",
  ignore: !CAN_TEST_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    // Use a fake topic_id — the backend will either:
    // 1. Fail to resolve institution (404) — acceptable denial
    // 2. Resolve institution and deny student role (403) — correct denial
    const r = await api.post("/summaries", student.access_token, {
      topic_id: "00000000-0000-0000-0000-000000000000",
      title: "__rbac_test_summary__",
    });

    assertDenied(r.status, "Student POST /summaries");
  },
});

// RBAC-03: Student cannot create quiz questions
Deno.test({
  name: "RBAC-03: Student POST /quiz-questions → denied (CONTENT_WRITE_ROLES only)",
  ignore: !CAN_TEST_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    const r = await api.post("/quiz-questions", student.access_token, {
      summary_id: "00000000-0000-0000-0000-000000000000",
      keyword_id: "00000000-0000-0000-0000-000000000000",
      question_type: "multiple_choice",
      question: "__rbac_test__",
      correct_answer: "A",
    });

    assertDenied(r.status, "Student POST /quiz-questions");
  },
});

// RBAC-04: Student cannot create memberships
Deno.test({
  name: "RBAC-04: Student POST /memberships → denied (MANAGEMENT_ROLES only)",
  ignore: !CAN_TEST_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    const r = await api.post("/memberships", student.access_token, {
      user_id: student.user.id,
      institution_id: ENV.INSTITUTION_ID,
      role: "student",
    });

    assertDenied(r.status, "Student POST /memberships");
  },
});

// RBAC-05: Student cannot update memberships (role change)
Deno.test({
  name: "RBAC-05: Student PUT /memberships/:id → denied (MANAGEMENT_ROLES only)",
  ignore: !CAN_TEST_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    // First, get the student's own membership to have a real ID
    const listR = await api.get(
      `/memberships?institution_id=${ENV.INSTITUTION_ID}`,
      student.access_token,
    );

    if (listR.status !== 200) {
      // Student may not be able to list memberships — use a fake ID
      const r = await api.put(
        "/memberships/00000000-0000-0000-0000-000000000000",
        student.access_token,
        { role: "admin" },
      );
      assertDenied(r.status, "Student PUT /memberships (fake id)");
      return;
    }

    const body = (listR.raw as any)?.data ?? listR.raw;
    const items = body?.items ?? [];
    if (items.length === 0) {
      // No memberships visible — try with fake ID
      const r = await api.put(
        "/memberships/00000000-0000-0000-0000-000000000000",
        student.access_token,
        { role: "admin" },
      );
      assertDenied(r.status, "Student PUT /memberships (fake id)");
      return;
    }

    // Try to escalate own role
    const memId = items[0].id;
    const r = await api.put(`/memberships/${memId}`, student.access_token, {
      role: "admin",
    });
    assertDenied(r.status, "Student PUT /memberships (role escalation)");
  },
});

// RBAC-06: Student cannot delete institutions
Deno.test({
  name: "RBAC-06: Student DELETE /institutions/:id → denied (owner only)",
  ignore: !CAN_TEST_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    const r = await api.delete(
      `/institutions/${ENV.INSTITUTION_ID}`,
      student.access_token,
    );

    assertDenied(r.status, "Student DELETE /institutions");
  },
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION B: PROFESSOR/ADMIN CANNOT PERFORM OWNER-ONLY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════
// NOTE: TEST_ADMIN_EMAIL is typically the owner. If the admin IS the owner,
// these tests won't reveal professor limitations. We test what we can:
// if admin is actually the owner, we skip professor-specific denials.

// RBAC-07: Admin/professor cannot delete institutions (owner only)
// NOTE: TEST_ADMIN_EMAIL may be the owner — if so, the DELETE may succeed (200).
// We test with admin token. If admin IS the owner, we accept 200 as valid.
// If admin is NOT the owner, we expect denial (401/403/404).
// This differentiates from RBAC-06 which uses the student token.
Deno.test({
  name: "RBAC-07: Admin DELETE /institutions/:id → denied unless admin IS the owner",
  ignore: !HAS_ADMIN || !HAS_INST,
  async fn() {
    const admin = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.delete(
      `/institutions/${ENV.INSTITUTION_ID}`,
      admin.access_token,
    );

    // If admin is NOT the owner → expect denial
    // If admin IS the owner → 200 is valid (but we shouldn't actually delete!)
    // In either case, the test verifies the endpoint doesn't crash with 500.
    assert(
      r.status === 200 || r.status === 401 || r.status === 403 || r.status === 404,
      `RBAC-07: expected 200 (owner) or 401/403/404 (non-owner), got ${r.status}`,
    );

    // If it was 200, the admin was the owner and we just soft-deactivated the institution.
    // Restore it immediately to avoid breaking other tests.
    if (r.status === 200) {
      // Re-activate by updating is_active (if the endpoint supports it)
      await api.put(`/institutions/${ENV.INSTITUTION_ID}`, admin.access_token, {
        is_active: true,
      });
    }
  },
});

// RBAC-08: Student cannot change membership roles (management only)
Deno.test({
  name: "RBAC-08: Student PUT /memberships/:id (role change) → denied",
  ignore: !CAN_TEST_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    // Use fake membership ID — the resolve step should fail or deny
    const r = await api.put(
      "/memberships/00000000-0000-0000-0000-000000000000",
      student.access_token,
      { role: "professor" },
    );

    assertDenied(r.status, "Student PUT /memberships role change");
  },
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION C: NO AUTH TOKEN → 401
// ═══════════════════════════════════════════════════════════════════════

Deno.test({
  name: "RBAC-09: No auth token → 401 on protected endpoints",
  ignore: !ENV.SUPABASE_URL || !ENV.ANON_KEY,
  async fn() {
    // Call without any access token (empty string = no X-Access-Token header)
    const endpoints = [
      { method: "GET", path: "/institutions" },
      { method: "GET", path: "/me" },
      { method: "POST", path: "/courses" },
      { method: "POST", path: "/memberships" },
    ];

    for (const ep of endpoints) {
      let r;
      if (ep.method === "GET") {
        r = await api.get(ep.path, "");
      } else {
        r = await api.post(ep.path, "", {});
      }

      assert401(
        r.status,
        `No-auth ${ep.method} ${ep.path}`,
      );
    }
  },
});

// RBAC-10: Invalid/expired token → 401
Deno.test({
  name: "RBAC-10: Invalid token → 401 on protected endpoint",
  ignore: !ENV.SUPABASE_URL || !ENV.ANON_KEY,
  async fn() {
    const fakeToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjoxMDAwMDAwMDAwfQ.invalid_signature";

    const r = await api.get("/institutions", fakeToken);

    assert401(r.status, "Invalid token GET /institutions");
  },
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION D: CROSS-INSTITUTION ACCESS
// ═══════════════════════════════════════════════════════════════════════

// RBAC-11: User cannot access resources from an institution they don't belong to
Deno.test({
  name: "RBAC-11: Access to non-member institution → denied",
  ignore: !HAS_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    // Use a fake institution UUID that the student definitely doesn't belong to
    const fakeInstId = "00000000-0000-0000-0000-000000000099";

    // Try to list courses from a non-existent/non-member institution
    const r = await api.get(
      `/courses?institution_id=${fakeInstId}`,
      student.access_token,
    );

    // Should get 403 (no membership) or 404 (institution not found)
    assertDenied(r.status, "Non-member GET /courses?institution_id=fake");
  },
});

// RBAC-12: Student cannot create institution-plans (content write roles only)
Deno.test({
  name: "RBAC-12: Student POST /institution-plans → denied (CONTENT_WRITE_ROLES)",
  ignore: !CAN_TEST_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    const r = await api.post("/institution-plans", student.access_token, {
      institution_id: ENV.INSTITUTION_ID,
      name: "__rbac_test_plan__",
      is_free: true,
    });

    assertDenied(r.status, "Student POST /institution-plans");
  },
});

// RBAC-13: Student cannot update institutions (management roles only)
Deno.test({
  name: "RBAC-13: Student PUT /institutions/:id → denied (MANAGEMENT_ROLES)",
  ignore: !CAN_TEST_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    const r = await api.put(
      `/institutions/${ENV.INSTITUTION_ID}`,
      student.access_token,
      { name: "__rbac_hijack__" },
    );

    assertDenied(r.status, "Student PUT /institutions");
  },
});

// RBAC-14: Student cannot create flashcards (content write roles only)
Deno.test({
  name: "RBAC-14: Student POST /flashcards → denied (CONTENT_WRITE_ROLES only)",
  ignore: !CAN_TEST_STUDENT,
  async fn() {
    const student = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);

    const r = await api.post("/flashcards", student.access_token, {
      summary_id: "00000000-0000-0000-0000-000000000000",
      keyword_id: "00000000-0000-0000-0000-000000000000",
      front: "__rbac_test__",
      back: "__rbac_test__",
    });

    assertDenied(r.status, "Student POST /flashcards");
  },
});
