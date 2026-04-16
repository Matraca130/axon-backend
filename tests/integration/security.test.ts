/**
 * tests/integration/security.test.ts — Security regression tests
 * Run: deno test tests/integration/security.test.ts --allow-net --allow-env --no-check
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { login, api, ENV, apiBase, assertStatus } from "../helpers/test-client.ts";

let adminToken: string; let userToken: string;
async function setup() {
  if (adminToken) return;
  adminToken = (await login(ENV.ADMIN_EMAIL, ENV.ADMIN_PASSWORD)).access_token;
  userToken = (await login(ENV.USER_EMAIL, ENV.USER_PASSWORD)).access_token;
}

Deno.test("SEC-001: no auth header returns 401/403", async () => {
  const r = await fetch(`${apiBase()}/courses?institution_id=${ENV.INSTITUTION_ID}`);
  assert(r.status === 401 || r.status === 403);
  await r.body?.cancel();
});

Deno.test("SEC-002: fake JWT returns 401/403", async () => {
  const r = await fetch(`${apiBase()}/courses?institution_id=${ENV.INSTITUTION_ID}`, {
    headers: { "Authorization": "Bearer fake", "apikey": ENV.ANON_KEY },
  });
  assert(r.status === 401 || r.status === 403);
  await r.body?.cancel();
});

Deno.test("SEC-003: expired JWT doesn't crash server", async () => {
  const h = btoa(JSON.stringify({alg:"HS256",typ:"JWT"}));
  const p = btoa(JSON.stringify({sub:"u",exp:Math.floor(Date.now()/1000)-3600}))
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const r = await fetch(`${apiBase()}/courses?institution_id=${ENV.INSTITUTION_ID}`, {
    headers: { "X-Access-Token": `${h}.${p}.s`, "Authorization": `Bearer ${ENV.ANON_KEY}` },
  });
  assert(r.status < 500);
  await r.body?.cancel();
});

Deno.test("SEC-004: SQL injection via section_id rejected", async () => {
  await setup();
  const r = await api.get("/topics?section_id=1;DROP TABLE topics;--", adminToken);
  assert(r.status >= 400);
  assertStatus(await api.get(`/courses?institution_id=${ENV.INSTITUTION_ID}`, adminToken), 200);
});

Deno.test("SEC-005: SQL injection via POST body handled safely", async () => {
  await setup();
  const r = await api.post("/keywords", adminToken, {
    summary_id: "550e8400-e29b-41d4-a716-446655440000",
    name: "'; DROP TABLE keywords; --",
  });
  assert(r.status < 500);
});

Deno.test("SEC-006: XSS in flashcard doesn't crash", async () => {
  await setup();
  const r = await api.post("/flashcards", adminToken, {
    summary_id: "550e8400-e29b-41d4-a716-446655440000",
    keyword_id: "660e8400-e29b-41d4-a716-446655440000",
    front: "<img src=x onerror=alert(1)>", back: "A",
  });
  assert(r.status < 500);
});

Deno.test("SEC-007: CORS allows X-Access-Token header", async () => {
  const r = await fetch(`${apiBase()}/health`, {
    method: "OPTIONS",
    headers: { Origin: "https://example.com", "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "X-Access-Token" },
  });
  const ah = r.headers.get("access-control-allow-headers") || "";
  assert(ah.toLowerCase().includes("x-access-token"));
  await r.body?.cancel();
});

Deno.test("SEC-008: student cannot create topics (RBAC)", async () => {
  await setup();
  const r = await api.post("/topics", userToken, {
    section_id: "550e8400-e29b-41d4-a716-446655440000", name: "Unauthorized",
  });
  assert(r.status === 403 || r.status === 404);
});

Deno.test("SEC-009: path traversal blocked", async () => {
  await setup();
  const r = await api.get("/courses/../../etc/passwd", adminToken);
  assert(r.status >= 400);
  assert(!JSON.stringify(r.raw).includes("root:"));
});

Deno.test("SEC-010: errors don't leak stack traces", async () => {
  await setup();
  const r = await api.get("/nonexistent", adminToken);
  const s = JSON.stringify(r.raw);
  assert(!s.includes("stack")); assert(!s.includes("at "));
});

// AXO-140 regression: 22 SECURITY DEFINER functions were callable by `anon` via
// PostgREST RPC, allowing unauthenticated RLS bypass. Migration
// 20260405000001_security_revoke_anon_all_definer_rpcs.sql revoked EXECUTE from
// anon on all of them. This test guards the anon boundary using one
// service_role-only RPC (award_xp) and one authenticated-only RPC
// (user_institution_ids) as representatives.
Deno.test("SEC-011: anon cannot call SECURITY DEFINER RPCs (AXO-140)", async () => {
  // award_xp — service_role only
  const r1 = await fetch(`${ENV.SUPABASE_URL}/rest/v1/rpc/award_xp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ENV.ANON_KEY,
      "Authorization": `Bearer ${ENV.ANON_KEY}`,
    },
    body: JSON.stringify({
      p_user_id: "00000000-0000-0000-0000-000000000000",
      p_source: "test",
      p_amount: 1,
    }),
  });
  // PostgREST returns 401/403 when the role lacks EXECUTE; 404 if the function
  // signature is unreachable to anon (also acceptable — anon can't see it).
  assert(
    r1.status === 401 || r1.status === 403 || r1.status === 404,
    `award_xp(anon) expected 401/403/404, got ${r1.status}`,
  );
  await r1.body?.cancel();

  // user_institution_ids — authenticated only (also locked out from anon)
  const r2 = await fetch(`${ENV.SUPABASE_URL}/rest/v1/rpc/user_institution_ids`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ENV.ANON_KEY,
      "Authorization": `Bearer ${ENV.ANON_KEY}`,
    },
    body: JSON.stringify({}),
  });
  assert(
    r2.status === 401 || r2.status === 403 || r2.status === 404,
    `user_institution_ids(anon) expected 401/403/404, got ${r2.status}`,
  );
  await r2.body?.cancel();
});
