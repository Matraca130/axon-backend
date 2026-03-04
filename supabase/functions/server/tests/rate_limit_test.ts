/**
 * Tests for rate-limit.ts — In-memory (fallback) rate limiter + key extraction.
 *
 * These tests cover:
 *   1. Local/in-memory rate limiting logic (checkRateLimitLocal)
 *   2. Key extraction from JWT tokens (extractKey) — C-1 FIX
 *
 * The distributed PostgreSQL-backed rate limiter is tested via
 * integration tests against a running Supabase instance.
 *
 * Run: deno test supabase/functions/server/tests/rate_limit_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractKey,
  checkRateLimitLocal,
  cleanupExpired,
  rateLimitMap,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "../rate-limit.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function resetRateLimit() {
  rateLimitMap.clear();
}

/**
 * Build a fake JWT with the given payload claims.
 * NOT cryptographically valid — only used for extractKey() tests.
 */
function buildFakeJwt(
  payload: Record<string, unknown>,
  signatureSuffix = "defaultSig",
): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  // Fake signature (not cryptographically valid, just unique per call)
  const sig = btoa(signatureSuffix + "_padding_to_make_it_long_enough")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${body}.${sig}`;
}

// ═════════════════════════════════════════════════════════════════
// C-1 FIX: extractKey() tests
// ═════════════════════════════════════════════════════════════════

Deno.test("extractKey: valid JWT with sub → uid:<uuid>", () => {
  const token = buildFakeJwt({ sub: "550e8400-e29b-41d4-a716-446655440000" });
  const key = extractKey(token);
  assertEquals(key, "uid:550e8400-e29b-41d4-a716-446655440000");
});

Deno.test("extractKey: same user, different signatures → same key", () => {
  const userId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const token1 = buildFakeJwt({ sub: userId }, "signature_v1");
  const token2 = buildFakeJwt({ sub: userId }, "signature_v2");
  assertEquals(extractKey(token1), extractKey(token2));
  assertEquals(extractKey(token1), `uid:${userId}`);
});

Deno.test("extractKey: different users → different keys", () => {
  const token1 = buildFakeJwt({ sub: "user-aaa" }, "same-sig");
  const token2 = buildFakeJwt({ sub: "user-bbb" }, "same-sig");
  const key1 = extractKey(token1);
  const key2 = extractKey(token2);
  assertEquals(key1.startsWith("uid:"), true);
  assertEquals(key2.startsWith("uid:"), true);
  assertEquals(key1 !== key2, true);
});

Deno.test("extractKey: JWT without sub → fallback to sig:", () => {
  const token = buildFakeJwt({ email: "no-sub@test.com" });
  const key = extractKey(token);
  assertEquals(key.startsWith("sig:"), true);
});

Deno.test("extractKey: JWT with empty sub → fallback to sig:", () => {
  const token = buildFakeJwt({ sub: "" });
  const key = extractKey(token);
  assertEquals(key.startsWith("sig:"), true);
});

Deno.test("extractKey: completely malformed token (no dots) → raw:", () => {
  const key = extractKey("this-is-not-a-jwt");
  assertEquals(key.startsWith("raw:"), true);
});

Deno.test("extractKey: token with dots but invalid base64 → sig:", () => {
  const key = extractKey("header.!!!invalid-base64!!!.signature-part");
  assertEquals(key.startsWith("sig:"), true);
});

Deno.test("extractKey: empty token → raw:", () => {
  const key = extractKey("");
  assertEquals(key.startsWith("raw:"), true);
});

Deno.test("extractKey: two tokens with same HS256 header get DIFFERENT keys", () => {
  // This is the actual bug scenario: both tokens share the same header
  // but have different subs → should produce different keys
  const token1 = buildFakeJwt({ sub: "user-111" });
  const token2 = buildFakeJwt({ sub: "user-222" });

  // Verify both tokens DO share the same first 32 chars (proving the old bug)
  assertEquals(token1.substring(0, 32), token2.substring(0, 32));

  // But extractKey produces DIFFERENT keys (the fix)
  const key1 = extractKey(token1);
  const key2 = extractKey(token2);
  assertEquals(key1 !== key2, true);
  assertEquals(key1, "uid:user-111");
  assertEquals(key2, "uid:user-222");
});

// ═════════════════════════════════════════════════════════════════
// Original tests: checkRateLimitLocal (unchanged)
// ═════════════════════════════════════════════════════════════════

Deno.test("checkRateLimitLocal: first request creates new window", () => {
  resetRateLimit();
  const result = checkRateLimitLocal("user-1", 1000);
  assertEquals(result.allowed, true);
  assertEquals(result.current, 1);
  assertEquals(rateLimitMap.size, 1);
});

Deno.test("checkRateLimitLocal: increments count within window", () => {
  resetRateLimit();
  const now = 1000;
  checkRateLimitLocal("user-1", now);
  checkRateLimitLocal("user-1", now + 100);
  const result = checkRateLimitLocal("user-1", now + 200);
  assertEquals(result.allowed, true);
  assertEquals(result.current, 3);
});

Deno.test("checkRateLimitLocal: blocks after max requests", () => {
  resetRateLimit();
  const now = 1000;

  // Fill up to max
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    const r = checkRateLimitLocal("user-1", now + i);
    assertEquals(r.allowed, true);
  }

  // Next request should be blocked
  const blocked = checkRateLimitLocal("user-1", now + RATE_LIMIT_MAX_REQUESTS);
  assertEquals(blocked.allowed, false);
  assertEquals(typeof blocked.retryAfterMs, "number");
});

Deno.test("checkRateLimitLocal: resets after window expires", () => {
  resetRateLimit();
  const now = 1000;

  // Fill up to max
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    checkRateLimitLocal("user-1", now);
  }

  // Should be blocked now
  assertEquals(checkRateLimitLocal("user-1", now).allowed, false);

  // After window expires, should be allowed again
  const afterWindow = now + RATE_LIMIT_WINDOW_MS + 1;
  const result = checkRateLimitLocal("user-1", afterWindow);
  assertEquals(result.allowed, true);
  assertEquals(result.current, 1);
});

Deno.test("checkRateLimitLocal: different users have independent limits", () => {
  resetRateLimit();
  const now = 1000;

  // Fill user-1 to max
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    checkRateLimitLocal("user-1", now);
  }
  assertEquals(checkRateLimitLocal("user-1", now).allowed, false);

  // user-2 should still be allowed
  const result = checkRateLimitLocal("user-2", now);
  assertEquals(result.allowed, true);
  assertEquals(result.current, 1);
});

Deno.test("cleanupExpired: removes expired entries", () => {
  resetRateLimit();
  const now = 1000;

  // Create entries with different expiry times
  checkRateLimitLocal("old-user", now); // expires at now + WINDOW_MS
  checkRateLimitLocal("new-user", now + RATE_LIMIT_WINDOW_MS + 500); // expires later

  assertEquals(rateLimitMap.size, 2);

  // Cleanup at a time after old-user expires but before new-user
  const cleaned = cleanupExpired(now + RATE_LIMIT_WINDOW_MS + 100);
  assertEquals(cleaned, 1);
  assertEquals(rateLimitMap.size, 1);
  assertEquals(rateLimitMap.has("new-user"), true);
  assertEquals(rateLimitMap.has("old-user"), false);
});

Deno.test("cleanupExpired: handles empty map", () => {
  resetRateLimit();
  const cleaned = cleanupExpired(Date.now());
  assertEquals(cleaned, 0);
});
