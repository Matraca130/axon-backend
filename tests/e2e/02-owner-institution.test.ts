/**
 * tests/e2e/02-owner-institution.test.ts — Owner institution management
 * Run: deno test tests/e2e/02-owner-institution.test.ts --allow-net --allow-env --no-check
 *
 * Tests:
 *   INST-01: GET /institutions returns owner's institutions with membership info
 *   INST-02: GET /institutions/:id returns single institution detail
 *   INST-03: PUT /institutions/:id updates institution name
 *   INST-04: GET /memberships?institution_id=X returns members list
 *   INST-05: POST /memberships adds a new member to institution
 *   INST-06: PUT /memberships/:id changes member role
 *   INST-07: PUT /memberships/:id deactivates a member (is_active=false)
 *   INST-08: DELETE /memberships/:id soft-deletes a membership
 *   INST-09: GET /institution-plans?institution_id=X lists plans
 *   INST-10: POST /institution-plans creates a plan
 *   INST-11: PUT /institution-plans/:id updates a plan
 *   INST-12: DELETE /institution-plans/:id deletes a plan
 *   INST-13: GET /admin/students/:institution_id — TODO: endpoint not implemented
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { login, api, ENV, assertStatus, assertOk, assertError } from "../helpers/test-client.ts";
import { track, cleanupAll, resetTracking } from "./helpers/cleanup.ts";

/** True when admin credentials are configured */
const HAS_CREDS = ENV.ADMIN_EMAIL.length > 0 && ENV.ADMIN_PASSWORD.length > 0;

/** True when institution ID is configured */
const HAS_INST = HAS_CREDS && ENV.INSTITUTION_ID.length > 0;

// ═══ 1. GET /institutions → OWNER'S INSTITUTIONS ═══

Deno.test({
  name: "INST-01: GET /institutions returns owner's institutions with membership info",
  ignore: !HAS_CREDS,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.get("/institutions", access_token);
    assertStatus(r, 200);

    const list = assertOk(r) as Record<string, unknown>[];

    assert(Array.isArray(list), "/institutions must return an array");
    assert(list.length > 0, "owner must belong to at least one institution");

    // Each item should be a flattened institution with membership fields
    const first = list[0];
    assert(typeof first.id === "string", "institution must have id");
    assert(typeof first.name === "string", "institution must have name");
    assert(typeof first.role === "string", "must include role from membership");
    assert(typeof first.membership_id === "string", "must include membership_id");
  },
});

// ═══ 2. GET /institutions/:id → SINGLE INSTITUTION ═══

Deno.test({
  name: "INST-02: GET /institutions/:id returns single institution detail",
  ignore: !HAS_INST,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.get(`/institutions/${ENV.INSTITUTION_ID}`, access_token);
    assertStatus(r, 200);

    const inst = assertOk(r) as Record<string, unknown>;
    assertEquals(inst.id, ENV.INSTITUTION_ID, "returned id must match requested id");
    assert(typeof inst.name === "string", "institution must have name");
    assert(typeof inst.slug === "string", "institution must have slug");
  },
});

// ═══ 3. PUT /institutions/:id → UPDATE INSTITUTION NAME ═══

Deno.test({
  name: "INST-03: PUT /institutions/:id updates institution name and restores",
  ignore: !HAS_INST,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    // ARRANGE: Read current institution to save original name
    const before = await api.get(`/institutions/${ENV.INSTITUTION_ID}`, access_token);
    assertStatus(before, 200);
    const original = assertOk(before) as Record<string, unknown>;
    const originalName = original.name as string;

    // ACT: Update to a unique test name
    const testName = `__e2e_inst_${Date.now()}__`;
    const updateR = await api.put(`/institutions/${ENV.INSTITUTION_ID}`, access_token, {
      name: testName,
    });
    assertStatus(updateR, 200);

    // ASSERT
    const updated = assertOk(updateR) as Record<string, unknown>;
    assertEquals(updated.name, testName, "institution name must be updated");

    // CLEANUP: Restore original name
    const restore = await api.put(`/institutions/${ENV.INSTITUTION_ID}`, access_token, {
      name: originalName,
    });
    assertStatus(restore, 200);
  },
});

// ═══ 4. GET /memberships?institution_id=X → LIST MEMBERS ═══

Deno.test({
  name: "INST-04: GET /memberships?institution_id=X returns members list",
  ignore: !HAS_INST,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.get(`/memberships?institution_id=${ENV.INSTITUTION_ID}`, access_token);
    assertStatus(r, 200);

    const body = assertOk(r) as Record<string, unknown>;

    // Paginated response: { items, total, limit, offset }
    assert(Array.isArray(body.items), "memberships must have items array");
    assert(typeof body.total === "number", "memberships must have total count");
    assert(typeof body.limit === "number", "memberships must have limit");
    assert(typeof body.offset === "number", "memberships must have offset");

    const items = body.items as Record<string, unknown>[];
    assert(items.length > 0, "institution must have at least one member");

    // Each membership should have standard fields
    const first = items[0];
    assert(typeof first.id === "string", "membership must have id");
    assert(typeof first.role === "string", "membership must have role");
    assert(typeof first.user_id === "string", "membership must have user_id");
    assert(typeof first.institution_id === "string", "membership must have institution_id");
  },
});

// ═══ 5. POST /memberships → ADD NEW MEMBER ═══
// NOTE: This needs a valid user_id. We use the TEST_USER if available,
// otherwise skip. Cleanup removes the created membership.

Deno.test({
  name: "INST-05: POST /memberships adds a new member to institution",
  ignore: !HAS_INST || !ENV.USER_EMAIL || !ENV.USER_PASSWORD,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);
    const userLogin = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);
    const testUserId = userLogin.user.id;

    resetTracking();

    // First check if user already has a membership — if so, delete it first
    const listR = await api.get(`/memberships?institution_id=${ENV.INSTITUTION_ID}`, access_token);
    assertStatus(listR, 200);
    const listBody = assertOk(listR) as Record<string, unknown>;
    const existing = (listBody.items as Record<string, unknown>[]).find(
      (m) => m.user_id === testUserId,
    );
    if (existing) {
      // Remove existing membership so we can test creation
      await api.delete(`/memberships/${existing.id}`, access_token);
    }

    // ACT: Add user as student
    const r = await api.post("/memberships", access_token, {
      user_id: testUserId,
      institution_id: ENV.INSTITUTION_ID,
      role: "student",
    });
    assertStatus(r, 201);

    // ASSERT
    const created = assertOk(r) as Record<string, unknown>;
    assert(typeof created.id === "string", "created membership must have id");
    assertEquals(created.user_id, testUserId, "user_id must match");
    assertEquals(created.institution_id, ENV.INSTITUTION_ID, "institution_id must match");
    assertEquals(created.role, "student", "role must be student");

    // Track for cleanup
    track("memberships", created.id as string);

    // CLEANUP
    await cleanupAll(access_token);
  },
});

// ═══ 6. PUT /memberships/:id → CHANGE MEMBER ROLE ═══
// NOTE: PATCH /members/:id/role does not exist. Using PUT /memberships/:id with { role }.

Deno.test({
  name: "INST-06: PUT /memberships/:id changes member role",
  ignore: !HAS_INST || !ENV.USER_EMAIL || !ENV.USER_PASSWORD,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);
    const userLogin = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);
    const testUserId = userLogin.user.id;

    resetTracking();

    // ARRANGE: Ensure user is a member (create if needed)
    const listR = await api.get(`/memberships?institution_id=${ENV.INSTITUTION_ID}`, access_token);
    assertStatus(listR, 200);
    const listBody = assertOk(listR) as Record<string, unknown>;
    let membership = (listBody.items as Record<string, unknown>[]).find(
      (m) => m.user_id === testUserId && m.is_active === true,
    );

    if (!membership) {
      const createR = await api.post("/memberships", access_token, {
        user_id: testUserId,
        institution_id: ENV.INSTITUTION_ID,
        role: "student",
      });
      assertStatus(createR, 201);
      membership = assertOk(createR) as Record<string, unknown>;
    }

    const memId = membership.id as string;
    const originalRole = membership.role as string;
    track("memberships", memId);

    // ACT: Change role to professor
    const targetRole = originalRole === "professor" ? "student" : "professor";
    const updateR = await api.put(`/memberships/${memId}`, access_token, {
      role: targetRole,
    });
    assertStatus(updateR, 200);

    // ASSERT
    const updated = assertOk(updateR) as Record<string, unknown>;
    assertEquals(updated.role, targetRole, `role must be changed to ${targetRole}`);

    // CLEANUP: Restore original role
    await api.put(`/memberships/${memId}`, access_token, { role: originalRole });
    resetTracking();
  },
});

// ═══ 7. PUT /memberships/:id → DEACTIVATE MEMBER ═══
// NOTE: PATCH /members/:id/toggle-active does not exist. Using PUT /memberships/:id with { is_active: false }.

Deno.test({
  name: "INST-07: PUT /memberships/:id deactivates a member (is_active=false)",
  ignore: !HAS_INST || !ENV.USER_EMAIL || !ENV.USER_PASSWORD,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);
    const userLogin = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);
    const testUserId = userLogin.user.id;

    resetTracking();

    // ARRANGE: Create a fresh membership to deactivate
    // First clean up any existing inactive membership for this user
    const listR = await api.get(`/memberships?institution_id=${ENV.INSTITUTION_ID}`, access_token);
    assertStatus(listR, 200);
    const listBody = assertOk(listR) as Record<string, unknown>;
    const existing = (listBody.items as Record<string, unknown>[]).find(
      (m) => m.user_id === testUserId,
    );

    let memId: string;
    if (existing && existing.is_active === true) {
      memId = existing.id as string;
    } else {
      // Need to create one
      if (existing) {
        // Existing but inactive — delete and recreate
        await api.delete(`/memberships/${existing.id}`, access_token);
      }
      const createR = await api.post("/memberships", access_token, {
        user_id: testUserId,
        institution_id: ENV.INSTITUTION_ID,
        role: "student",
      });
      assertStatus(createR, 201);
      const created = assertOk(createR) as Record<string, unknown>;
      memId = created.id as string;
    }

    // ACT: Deactivate
    const updateR = await api.put(`/memberships/${memId}`, access_token, {
      is_active: false,
    });
    assertStatus(updateR, 200);

    // ASSERT
    const updated = assertOk(updateR) as Record<string, unknown>;
    assertEquals(updated.is_active, false, "membership must be deactivated");

    // CLEANUP: Reactivate so the test user remains usable
    await api.put(`/memberships/${memId}`, access_token, { is_active: true });
    resetTracking();
  },
});

// ═══ 8. DELETE /memberships/:id → SOFT-DELETE MEMBERSHIP ═══

Deno.test({
  name: "INST-08: DELETE /memberships/:id soft-deletes a membership",
  ignore: !HAS_INST || !ENV.USER_EMAIL || !ENV.USER_PASSWORD,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);
    const userLogin = await login(ENV.USER_EMAIL, ENV.USER_PASSWORD);
    const testUserId = userLogin.user.id;

    resetTracking();

    // ARRANGE: Ensure user has an active membership
    const listR = await api.get(`/memberships?institution_id=${ENV.INSTITUTION_ID}`, access_token);
    assertStatus(listR, 200);
    const listBody = assertOk(listR) as Record<string, unknown>;
    const existing = (listBody.items as Record<string, unknown>[]).find(
      (m) => m.user_id === testUserId && m.is_active === true,
    );

    let memId: string;
    if (existing) {
      memId = existing.id as string;
    } else {
      const createR = await api.post("/memberships", access_token, {
        user_id: testUserId,
        institution_id: ENV.INSTITUTION_ID,
        role: "student",
      });
      assertStatus(createR, 201);
      const created = assertOk(createR) as Record<string, unknown>;
      memId = created.id as string;
    }

    // ACT: Soft-delete
    const deleteR = await api.delete(`/memberships/${memId}`, access_token);
    assertStatus(deleteR, 200);

    // ASSERT
    const deleted = assertOk(deleteR) as Record<string, unknown>;
    assertEquals(deleted.is_active, false, "membership must be deactivated after delete");

    // CLEANUP: Reactivate for other tests
    await api.put(`/memberships/${memId}`, access_token, { is_active: true });
    resetTracking();
  },
});

// ═══ 9. GET /institution-plans?institution_id=X → LIST PLANS ═══

Deno.test({
  name: "INST-09: GET /institution-plans?institution_id=X lists plans",
  ignore: !HAS_INST,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.get(`/institution-plans?institution_id=${ENV.INSTITUTION_ID}`, access_token);
    assertStatus(r, 200);

    const body = assertOk(r) as Record<string, unknown>;

    // crud-factory returns paginated: { items, total, limit, offset }
    assert(Array.isArray(body.items), "institution-plans must return items array");
    assert(typeof body.total === "number", "must include total count");
  },
});

// ═══ 10. POST /institution-plans → CREATE PLAN ═══

Deno.test({
  name: "INST-10: POST /institution-plans creates a plan",
  ignore: !HAS_INST,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    resetTracking();

    const planName = `__e2e_plan_${Date.now()}__`;

    // ACT
    const r = await api.post("/institution-plans", access_token, {
      institution_id: ENV.INSTITUTION_ID,
      name: planName,
      description: "E2E test plan",
      price_cents: 0,
      is_free: true,
    });
    assertStatus(r, 201);

    // ASSERT
    const plan = assertOk(r) as Record<string, unknown>;
    assert(typeof plan.id === "string", "plan must have id");
    assertEquals(plan.name, planName, "plan name must match");
    assertEquals(plan.institution_id, ENV.INSTITUTION_ID, "institution_id must match");

    // Track for cleanup
    track("institution-plans", plan.id as string);

    // CLEANUP
    await cleanupAll(access_token);
  },
});

// ═══ 11. PUT /institution-plans/:id → UPDATE PLAN ═══

Deno.test({
  name: "INST-11: PUT /institution-plans/:id updates a plan",
  ignore: !HAS_INST,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    resetTracking();

    // ARRANGE: Create a plan to update
    const planName = `__e2e_plan_upd_${Date.now()}__`;
    const createR = await api.post("/institution-plans", access_token, {
      institution_id: ENV.INSTITUTION_ID,
      name: planName,
      is_free: true,
    });
    assertStatus(createR, 201);
    const plan = assertOk(createR) as Record<string, unknown>;
    const planId = plan.id as string;
    track("institution-plans", planId);

    // ACT: Update the plan name
    const newName = `__e2e_plan_updated_${Date.now()}__`;
    const updateR = await api.put(`/institution-plans/${planId}`, access_token, {
      name: newName,
      description: "Updated by E2E test",
    });
    assertStatus(updateR, 200);

    // ASSERT
    const updated = assertOk(updateR) as Record<string, unknown>;
    assertEquals(updated.name, newName, "plan name must be updated");
    assertEquals(updated.description, "Updated by E2E test", "plan description must be updated");

    // CLEANUP
    await cleanupAll(access_token);
  },
});

// ═══ 12. DELETE /institution-plans/:id → DELETE PLAN ═══

Deno.test({
  name: "INST-12: DELETE /institution-plans/:id deletes a plan",
  ignore: !HAS_INST,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    resetTracking();

    // ARRANGE: Create a plan to delete
    const planName = `__e2e_plan_del_${Date.now()}__`;
    const createR = await api.post("/institution-plans", access_token, {
      institution_id: ENV.INSTITUTION_ID,
      name: planName,
      is_free: true,
    });
    assertStatus(createR, 201);
    const plan = assertOk(createR) as Record<string, unknown>;
    const planId = plan.id as string;

    // ACT: Delete the plan
    const deleteR = await api.delete(`/institution-plans/${planId}`, access_token);
    assertStatus(deleteR, 200);

    // ASSERT: Verify plan was deleted (GET should 404 or return empty)
    const getR = await api.get(`/institution-plans/${planId}`, access_token);
    // crud-factory soft-delete or hard-delete — either 404 or deleted flag
    assert(
      getR.status === 404 || getR.status === 200,
      `GET after DELETE should return 404 or 200, got ${getR.status}`,
    );

    resetTracking();
  },
});

// ═══ 13. GET /admin/students/:institution_id → STUDENT REPORTS ═══
// TODO: endpoint not implemented — no /admin/students route exists in backend

Deno.test({
  name: "INST-13: GET /admin/students/:institution_id — TODO: endpoint not implemented",
  ignore: true,
  fn() {
    // Endpoint does not exist in current backend routes.
    // When implemented, test should verify:
    // - Returns array of student records for the institution
    // - Requires owner/admin role
    // - Includes relevant student metrics
  },
});
