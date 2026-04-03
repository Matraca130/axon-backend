/**
 * tests/e2e/01-auth-flow.test.ts — Auth & profile flow tests
 * Run: deno test tests/e2e/01-auth-flow.test.ts --allow-net --allow-env --no-check
 *
 * Tests:
 *   AUTH-01: Login with valid credentials returns JWT
 *   AUTH-02: Login with wrong password returns 400
 *   AUTH-03: GET /me returns profile with correct email
 *   AUTH-04: PUT /me updates full_name and verifies change
 *   AUTH-05: GET /institutions returns user institutions list
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { login, api, ENV, assertStatus, assertOk, assertError } from "../helpers/test-client.ts";

/** True when admin credentials are configured */
const HAS_CREDS = ENV.ADMIN_EMAIL.length > 0 && ENV.ADMIN_PASSWORD.length > 0;

// ═══ 1. LOGIN WITH VALID CREDENTIALS → JWT ═══

Deno.test({
  name: "AUTH-01: Login with valid credentials returns JWT",
  ignore: !HAS_CREDS,
  async fn() {
    const result = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    assert(typeof result.access_token === "string", "must return access_token");
    assert(result.access_token.length > 0, "access_token must not be empty");
    assert(typeof result.refresh_token === "string", "must return refresh_token");
    assert(typeof result.user === "object", "must return user object");
    assertEquals(result.user.email, ENV.ADMIN_EMAIL, "user email must match");

    // JWT should have 3 dot-separated parts
    const parts = result.access_token.split(".");
    assertEquals(parts.length, 3, "access_token must be a valid JWT (3 parts)");
  },
});

// ═══ 2. LOGIN WITH WRONG PASSWORD → 400 ═══

Deno.test({
  name: "AUTH-02: Login with wrong password returns 400",
  ignore: !HAS_CREDS,
  async fn() {
    // Supabase Auth returns 400 for invalid credentials
    const res = await fetch(
      `${ENV.SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": ENV.ANON_KEY,
        },
        body: JSON.stringify({
          email: ENV.ADMIN_EMAIL,
          password: "__wrong_password_e2e_test__",
        }),
      },
    );

    assertEquals(res.status, 400, "wrong password must return 400");
    const body = await res.json();
    assert(
      typeof body.error === "string" || typeof body.error_description === "string",
      "response must include error info",
    );
  },
});

// ═══ 3. GET /me → PROFILE WITH CORRECT EMAIL ═══

Deno.test({
  name: "AUTH-03: GET /me returns profile with correct email",
  ignore: !HAS_CREDS,
  async fn() {
    const { access_token, user } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.get("/me", access_token);
    assertStatus(r, 200);

    const profile = assertOk(r) as Record<string, unknown>;

    assert(typeof profile === "object", "/me must return an object");
    assert(typeof profile.id === "string", "profile must have id");
    assertEquals(profile.id, user.id, "profile id must match logged-in user id");
    assertEquals(profile.email, user.email, "profile email must match login email");
  },
});

// ═══ 4. PUT /me → UPDATE NAME → VERIFY CHANGE ═══

Deno.test({
  name: "AUTH-04: PUT /me updates full_name and verifies change",
  ignore: !HAS_CREDS,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    // Step 1: Read current profile to save original name
    const before = await api.get("/me", access_token);
    assertStatus(before, 200);
    const originalProfile = assertOk(before) as Record<string, unknown>;
    const originalName = originalProfile.full_name ?? "";

    // Step 2: Update to a unique test name
    const testName = `__e2e_test_${Date.now()}__`;
    const updateR = await api.put("/me", access_token, { full_name: testName });
    assertStatus(updateR, 200);
    const updated = assertOk(updateR) as Record<string, unknown>;
    assertEquals(updated.full_name, testName, "updated profile must have new name");

    // Step 3: GET /me again to verify persistence
    const after = await api.get("/me", access_token);
    assertStatus(after, 200);
    const afterProfile = assertOk(after) as Record<string, unknown>;
    assertEquals(afterProfile.full_name, testName, "name must persist after GET");

    // Step 4: Restore original name (cleanup)
    const restore = await api.put("/me", access_token, {
      full_name: originalName,
    });
    assertStatus(restore, 200);
  },
});

// ═══ 5. GET /institutions → LIST USER INSTITUTIONS ═══

Deno.test({
  name: "AUTH-05: GET /institutions returns user institutions list",
  ignore: !HAS_CREDS,
  async fn() {
    const { access_token } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

    const r = await api.get("/institutions", access_token);
    assertStatus(r, 200);

    const list = assertOk(r) as unknown[];

    assert(Array.isArray(list), "/institutions must return an array");
    assert(list.length > 0, "admin user must belong to at least one institution");

    // Backend spreads institution fields flat alongside membership_id and role
    const first = list[0] as Record<string, unknown>;
    assert(typeof first.id === "string", "institution must have id (flat shape)");
    assert(typeof first.name === "string", "institution must have name (flat shape)");
    assert(typeof first.role === "string", "must have role");
    assert(typeof first.membership_id === "string", "must have membership_id");

    // If TEST_INSTITUTION_ID is set, verify it appears in the list
    if (ENV.INSTITUTION_ID) {
      const match = list.find(
        (m: any) => m.id === ENV.INSTITUTION_ID,
      );
      assert(match, `institution ${ENV.INSTITUTION_ID} must appear in user's list`);
    }
  },
});
