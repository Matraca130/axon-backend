/**
 * tests/e2e/00-smoke.test.ts — Smoke tests: health, auth, profile
 * Run: deno test tests/e2e/00-smoke.test.ts --allow-net --allow-env --no-check
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { login, api, ENV, assertStatus } from "../helpers/test-client.ts";

// ═══ 1. HEALTH CHECK ═══

Deno.test("SMOKE-01: GET /health returns 200 with status ok", async () => {
  const r = await api.get("/health", "");
  // /health does NOT require auth — uses c.json() directly (no { data } wrapper)
  assertStatus(r, 200);
  assertEquals((r.raw as any).status, "ok");
  assert(typeof (r.raw as any).version === "string", "health must include version");
});

// ═══ 2. LOGIN → ACCESS TOKEN ═══

Deno.test("SMOKE-02: Login with valid credentials returns access_token", async () => {
  const email = ENV.ADMIN_EMAIL;
  const password = ENV.ADMIN_PASSWORD;
  assert(email.length > 0, "TEST_ADMIN_EMAIL env var must be set");
  assert(password.length > 0, "TEST_ADMIN_PASSWORD env var must be set");

  const result = await login(email, password);

  assert(typeof result.access_token === "string", "must return access_token");
  assert(result.access_token.length > 0, "access_token must not be empty");
  assert(typeof result.user === "object", "must return user object");
  assert(typeof result.user.id === "string", "user must have id");
  assertEquals(result.user.email, email, "user email must match login email");
});

// ═══ 3. GET /me WITH TOKEN → USER PROFILE ═══

Deno.test("SMOKE-03: GET /me with valid token returns user profile", async () => {
  const { access_token, user } = await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD);

  const r = await api.get("/me", access_token);
  assertStatus(r, 200);

  // /me uses ok() wrapper, so raw is { data: { ... } }
  const body = r.raw as any;
  const profile = body?.data !== undefined ? body.data : body;

  assert(typeof profile === "object", "/me must return an object");
  assert(typeof profile.id === "string", "profile must have id");
  assertEquals(profile.id, user.id, "profile id must match logged-in user id");
  // email may be in profile or may not, depending on backend implementation
  if (profile.email) {
    assertEquals(profile.email, user.email, "profile email must match");
  }
});
