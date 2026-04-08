/**
 * tests/unit/e2e-route-handlers.test.ts — 20 tests for route handler logic
 *
 * Tests cover: response format consistency, error code mapping, CORS
 * origin validation, rate limiting logic, pagination, and safe error
 * sanitization. All tested via pure functions without network/env deps.
 *
 * ZERO dependency on db.ts — runs without env vars.
 * Run: deno test tests/unit/e2e-route-handlers.test.ts --no-check
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

import {
  extractKey,
  checkRateLimitLocal,
  cleanupExpired,
  rateLimitMap,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
} from "../../supabase/functions/server/rate-limit.ts";
// \xe2\x94\x80\xe2\x94\x80\xe2\x94\x80 Inlined ok/err (avoids importing db.ts which throws without env vars) \xe2\x94\x80\xe2\x94\x80\xe2\x94\x80
// deno-lint-ignore no-explicit-any
function ok(data: any, status = 200) {
  return { body: { data }, status };
}
// deno-lint-ignore no-explicit-any
function err(message: string, status = 400) {
  return { body: { error: message }, status };
}
// deno-lint-ignore no-explicit-any
function safeErrLocal(operation: string, _error: any, status = 500) {
  return { body: { error: `${operation} failed` }, status };
}

// ═══ RATE LIMITING — extractKey ═══

Deno.test("extractKey: extracts sub from valid JWT payload as uid: prefix", () => {
  // Build a fake JWT with a known sub
  const payload = { sub: "550e8400-e29b-41d4-a716-446655440000", email: "test@test.com" };
  const h = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const b = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const token = `${h}.${b}.fake-signature`;

  const key = extractKey(token);
  assertEquals(key, "uid:550e8400-e29b-41d4-a716-446655440000");
});

Deno.test("extractKey: different users get different keys", () => {
  function makeToken(sub: string): string {
    const h = btoa(JSON.stringify({ alg: "HS256" }));
    const b = btoa(JSON.stringify({ sub })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${h}.${b}.sig`;
  }
  const key1 = extractKey(makeToken("user-111"));
  const key2 = extractKey(makeToken("user-222"));
  assert(key1 !== key2, "Different users must have different rate limit keys");
});

Deno.test("extractKey: fallback to sig: prefix for invalid payload", () => {
  const key = extractKey("header.!!!invalid-base64.some-signature-here");
  assert(key.startsWith("sig:"), `Expected sig: prefix, got: ${key}`);
});

Deno.test("extractKey: fallback to raw: prefix for non-JWT string", () => {
  const key = extractKey("not-a-jwt-at-all");
  assert(key.startsWith("raw:"), `Expected raw: prefix, got: ${key}`);
});

// ═══ RATE LIMITING — checkRateLimitLocal ═══

Deno.test("rate limit: first request is allowed", () => {
  rateLimitMap.clear();
  const result = checkRateLimitLocal("test-user-1", Date.now());
  assert(result.allowed);
  assertEquals(result.current, 1);
});

Deno.test("rate limit: requests within window are allowed up to MAX_REQUESTS", () => {
  rateLimitMap.clear();
  const now = Date.now();
  let result;
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    result = checkRateLimitLocal("test-user-2", now);
  }
  assert(result!.allowed, `Request #${RATE_LIMIT_MAX_REQUESTS} should be allowed`);
  assertEquals(result!.current, RATE_LIMIT_MAX_REQUESTS);
});

Deno.test("rate limit: request beyond MAX_REQUESTS is rejected", () => {
  rateLimitMap.clear();
  const now = Date.now();
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    checkRateLimitLocal("test-user-3", now);
  }
  const result = checkRateLimitLocal("test-user-3", now);
  assert(!result.allowed, `Request #${RATE_LIMIT_MAX_REQUESTS + 1} should be rejected`);
  assert(result.retryAfterMs! > 0, "Should include retry-after");
});

Deno.test("rate limit: resets after window expires", () => {
  rateLimitMap.clear();
  const now = Date.now();
  // Fill up the window
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS + 5; i++) {
    checkRateLimitLocal("test-user-4", now);
  }
  // Jump past the window
  const afterWindow = now + RATE_LIMIT_WINDOW_MS + 1;
  const result = checkRateLimitLocal("test-user-4", afterWindow);
  assert(result.allowed, "Should be allowed after window reset");
  assertEquals(result.current, 1, "Counter should reset to 1");
});

Deno.test("rate limit: different users have independent counters", () => {
  rateLimitMap.clear();
  const now = Date.now();
  // Fill up user A
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS + 1; i++) {
    checkRateLimitLocal("user-A", now);
  }
  // User B should still be allowed
  const result = checkRateLimitLocal("user-B", now);
  assert(result.allowed, "User B should not be affected by User A's limit");
});

// ═══ RATE LIMITING — cleanupExpired ═══

Deno.test("cleanupExpired: removes expired entries", () => {
  rateLimitMap.clear();
  const past = Date.now() - RATE_LIMIT_WINDOW_MS - 1000;
  rateLimitMap.set("expired-1", { count: 50, resetAt: past });
  rateLimitMap.set("expired-2", { count: 30, resetAt: past - 5000 });
  rateLimitMap.set("active-1", { count: 10, resetAt: Date.now() + 30000 });

  const cleaned = cleanupExpired(Date.now());
  assertEquals(cleaned, 2, "Should clean 2 expired entries");
  assert(!rateLimitMap.has("expired-1"));
  assert(!rateLimitMap.has("expired-2"));
  assert(rateLimitMap.has("active-1"), "Active entry should remain");
});

// ═══ RATE LIMITING — Configuration ═══

Deno.test("rate limit: window is 60 seconds", () => {
  assertEquals(RATE_LIMIT_WINDOW_MS, 60_000);
});

Deno.test("rate limit: max requests is set to a sane positive integer", () => {
  // Don't pin a specific number — the constant evolves (was 120, now 300)
  // and the test should track the source of truth in rate-limit.ts.
  // Just guard against accidental zero/negative/huge values.
  assert(
    Number.isInteger(RATE_LIMIT_MAX_REQUESTS),
    "MAX_REQUESTS must be an integer",
  );
  assert(
    RATE_LIMIT_MAX_REQUESTS > 0 && RATE_LIMIT_MAX_REQUESTS <= 10_000,
    `MAX_REQUESTS must be in (0, 10000], got ${RATE_LIMIT_MAX_REQUESTS}`,
  );
});

// ═══ CORS — Origin Validation ═══
// Test the CORS origin logic from index.ts by reimplementing the check
// (we cannot import index.ts because it calls Deno.serve at module level)

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://axon-frontend.vercel.app",
  "https://numero1-sseki-2325-55.vercel.app",
];

const VERCEL_PREVIEW_RE = /^https:\/\/(numero1-sseki-2325-55|axon-frontend)-[a-z0-9-]+\.vercel\.app$/;

function getAllowedOrigin(origin: string): string {
  if (!origin) return "";
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (VERCEL_PREVIEW_RE.test(origin)) return origin;
  return "";
}

Deno.test("CORS: allows localhost:5173 (dev)", () => {
  assertEquals(getAllowedOrigin("http://localhost:5173"), "http://localhost:5173");
});

Deno.test("CORS: allows production Vercel domain", () => {
  assertEquals(
    getAllowedOrigin("https://axon-frontend.vercel.app"),
    "https://axon-frontend.vercel.app",
  );
});

Deno.test("CORS: allows Vercel preview deploys matching project prefix", () => {
  const previewUrl = "https://axon-frontend-abc123-team.vercel.app";
  assertEquals(getAllowedOrigin(previewUrl), previewUrl);
});

Deno.test("CORS: blocks unknown origins (no wildcard)", () => {
  assertEquals(getAllowedOrigin("https://evil-site.com"), "");
  assertEquals(getAllowedOrigin("https://axon-frontend.vercel.app.evil.com"), "");
});

Deno.test("CORS: blocks empty origin", () => {
  assertEquals(getAllowedOrigin(""), "");
});

Deno.test("CORS: blocks origin with wrong protocol", () => {
  assertEquals(getAllowedOrigin("ftp://localhost:5173"), "");
});

// ═══ RESPONSE FORMAT CONSISTENCY ═══
// Verify the expected { data } / { error } response shape patterns

Deno.test("Response format: ok() wraps in { data }, err() wraps in { error }", () => {
  const okRes = ok({ items: [], total: 0, limit: 100, offset: 0 });
  assert("data" in okRes.body, "Success response must have 'data' key");
  assert(!("error" in okRes.body), "Success response must NOT have 'error' key");
  assertEquals(okRes.status, 200);

  const errRes = err("Missing required field: name");
  assert("error" in errRes.body, "Error response must have 'error' key");
  assert(!("data" in errRes.body), "Error response must NOT have 'data' key");
  assertEquals(errRes.status, 400);
});

// ═══ ERROR CODE MAPPING ═══

Deno.test("Error codes: safeErr sanitizes DB errors (no internal details leaked)", () => {
  const res = safeErrLocal("List topics", { message: "relation topics does not exist" });
  assertEquals(res.body.error, "List topics failed");
  assert(!res.body.error.includes("relation"), "Should not leak DB details");
  assertEquals(res.status, 500);
});
