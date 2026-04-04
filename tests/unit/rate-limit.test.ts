/**
 * tests/unit/rate-limit.test.ts — Unit tests for rate limiter
 *
 * Tests the in-memory rate limiting implementation.
 * No external dependencies (Map-based, no DB calls).
 */

import {
  assertEquals,
  assert,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  type RateLimitEntry,
  rateLimitMap,
  extractKey,
  cleanupExpired,
  checkRateLimitLocal,
} from "../../supabase/functions/server/rate-limit.ts";

Deno.test("extractKey: decodes JWT payload and returns uid prefix", () => {
  // Valid JWT with sub claim
  const validJWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC1hYmNkLWVmMDEtMjM0NSIsIm5hbWUiOiJKb2huIERvZSJ9.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ";
  const key = extractKey(validJWT);
  assert(key.startsWith("uid:"), "Should extract user ID from JWT");
  assertEquals(key, "uid:12345678-abcd-ef01-2345");
});

Deno.test("extractKey: uses signature as fallback when payload is invalid", () => {
  // JWT with invalid payload (will fail base64 decode)
  const invalidPayloadJWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.!!!invalid!!!.signature";
  const key = extractKey(invalidPayloadJWT);
  assert(key.startsWith("sig:"), "Should fall back to signature-based key");
});

Deno.test("extractKey: uses raw fallback for malformed tokens", () => {
  const malformedJWT = "no-dots-here";
  const key = extractKey(malformedJWT);
  assert(key.startsWith("raw:"), "Should fall back to raw token suffix");
});

Deno.test("extractKey: handles JWT without sub claim", () => {
  // JWT without sub field
  const noSubJWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoiSm9obiBEb2UifQ.PpQMBWGQr14Huk5gSwuRwuMqk-3mOWs4pKYh9F1YXc8";
  const key = extractKey(noSubJWT);
  assert(key.startsWith("sig:"), "Should fall back to signature when sub is missing");
});

Deno.test("checkRateLimitLocal: allows first request", () => {
  rateLimitMap.clear();
  const result = checkRateLimitLocal("test:user1", 1000);
  assertEquals(result.allowed, true, "First request should be allowed");
  assertEquals(result.current, 1, "Counter should be 1");
});

Deno.test("checkRateLimitLocal: increments counter on subsequent requests", () => {
  rateLimitMap.clear();
  const now = 1000;

  const result1 = checkRateLimitLocal("test:user1", now);
  assertEquals(result1.current, 1);

  const result2 = checkRateLimitLocal("test:user1", now + 100);
  assertEquals(result2.current, 2);

  const result3 = checkRateLimitLocal("test:user1", now + 200);
  assertEquals(result3.current, 3);
});

Deno.test("checkRateLimitLocal: allows requests up to MAX_REQUESTS", () => {
  rateLimitMap.clear();
  const now = 1000;

  for (let i = 1; i <= RATE_LIMIT_MAX_REQUESTS; i++) {
    const result = checkRateLimitLocal("test:user1", now);
    assertEquals(result.allowed, true, `Request ${i} should be allowed`);
  }
});

Deno.test("checkRateLimitLocal: blocks request beyond MAX_REQUESTS", () => {
  rateLimitMap.clear();
  const now = 1000;

  // Fill the bucket
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    checkRateLimitLocal("test:user1", now);
  }

  // Next request should be blocked
  const result = checkRateLimitLocal("test:user1", now);
  assertEquals(
    result.allowed,
    false,
    "Request exceeding limit should be blocked",
  );
  assertEquals(result.current, RATE_LIMIT_MAX_REQUESTS + 1);
  assert(result.retryAfterMs, "Should provide retry-after duration");
});

Deno.test("checkRateLimitLocal: resets counter after window expires", () => {
  rateLimitMap.clear();
  const baseTime = 1000;

  // Fill bucket
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    checkRateLimitLocal("test:user1", baseTime);
  }

  // Exceed limit
  const blockedResult = checkRateLimitLocal("test:user1", baseTime);
  assertEquals(blockedResult.allowed, false);

  // Move time past window
  const newTime = baseTime + RATE_LIMIT_WINDOW_MS + 1;
  const result = checkRateLimitLocal("test:user1", newTime);
  assertEquals(result.allowed, true, "Should allow request after window expires");
  assertEquals(result.current, 1, "Counter should reset to 1");
});

Deno.test("checkRateLimitLocal: separate users have separate buckets", () => {
  rateLimitMap.clear();
  const now = 1000;

  // User 1 makes requests
  for (let i = 0; i < 50; i++) {
    checkRateLimitLocal("test:user1", now);
  }

  // User 2 should have its own bucket
  const user2Result = checkRateLimitLocal("test:user2", now);
  assertEquals(user2Result.allowed, true);
  assertEquals(user2Result.current, 1, "User 2 should have independent counter");
});

Deno.test("checkRateLimitLocal: returns retry-after milliseconds when blocked", () => {
  rateLimitMap.clear();
  const baseTime = 1000;

  // Fill bucket
  for (let i = 0; i <= RATE_LIMIT_MAX_REQUESTS; i++) {
    checkRateLimitLocal("test:user1", baseTime);
  }

  const blockedResult = checkRateLimitLocal("test:user1", baseTime);
  assert(blockedResult.retryAfterMs, "Should have retry-after");
  assert(
    blockedResult.retryAfterMs > 0 && blockedResult.retryAfterMs <= RATE_LIMIT_WINDOW_MS,
    "Retry-after should be positive and within window",
  );
});

Deno.test("cleanupExpired: removes expired entries", () => {
  rateLimitMap.clear();
  const baseTime = 1000;

  // Create entries at different times
  const entry1: RateLimitEntry = { count: 1, resetAt: baseTime + 1000 };
  const entry2: RateLimitEntry = { count: 2, resetAt: baseTime + 500 };
  rateLimitMap.set("user1", entry1);
  rateLimitMap.set("user2", entry2);

  assertEquals(rateLimitMap.size, 2, "Should have 2 entries initially");

  // Cleanup at time when only user2 is expired
  const cleaned = cleanupExpired(baseTime + 600);
  assertEquals(cleaned, 1, "Should clean 1 expired entry");
  assertEquals(rateLimitMap.size, 1, "Should have 1 entry remaining");
  assertEquals(
    rateLimitMap.has("user1"),
    true,
    "user1 (non-expired) should remain",
  );
  assertEquals(rateLimitMap.has("user2"), false, "user2 (expired) should be removed");
});

Deno.test("cleanupExpired: returns count of cleaned entries", () => {
  rateLimitMap.clear();
  const baseTime = 1000;

  // Create multiple expired entries
  for (let i = 0; i < 10; i++) {
    rateLimitMap.set(`user${i}`, { count: i, resetAt: baseTime + 100 });
  }

  const cleaned = cleanupExpired(baseTime + 200);
  assertEquals(cleaned, 10, "Should report all 10 cleaned entries");
});

Deno.test("cleanupExpired: handles empty map", () => {
  rateLimitMap.clear();
  const cleaned = cleanupExpired(1000);
  assertEquals(cleaned, 0, "Should return 0 when map is empty");
  assertEquals(rateLimitMap.size, 0, "Map should remain empty");
});

Deno.test("checkRateLimitLocal: handles concurrent-like requests", () => {
  rateLimitMap.clear();
  const now = 1000;

  // Simulate rapid requests from same user
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(checkRateLimitLocal("test:user1", now));
  }

  // All should be allowed (under limit)
  results.forEach((result, i) => {
    assertEquals(result.allowed, true, `Request ${i} should be allowed`);
  });

  // Counters should be sequential
  results.forEach((result, i) => {
    assertEquals(result.current, i + 1, `Counter should be ${i + 1}`);
  });
});

Deno.test("checkRateLimitLocal: boundary at exactly MAX_REQUESTS", () => {
  rateLimitMap.clear();
  const now = 1000;

  // Use exactly MAX_REQUESTS requests
  let lastResult;
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    lastResult = checkRateLimitLocal("test:user1", now);
  }

  assertEquals(lastResult!.allowed, true, "Request at limit should be allowed");
  assertEquals(lastResult!.current, RATE_LIMIT_MAX_REQUESTS);

  // One more should be blocked
  const nextResult = checkRateLimitLocal("test:user1", now);
  assertEquals(nextResult.allowed, false, "Request beyond limit should be blocked");
});

Deno.test("checkRateLimitLocal: preserves entry until window expires", () => {
  rateLimitMap.clear();
  const baseTime = 1000;

  // Make 10 requests
  for (let i = 0; i < 10; i++) {
    checkRateLimitLocal("test:user1", baseTime);
  }

  // Just before window expires, should still have high count
  let result = checkRateLimitLocal("test:user1", baseTime + RATE_LIMIT_WINDOW_MS - 1);
  assertEquals(result.current, 11, "Counter should persist until window expires");

  // Just after window expiry, should reset (when now > resetAt)
  result = checkRateLimitLocal("test:user1", baseTime + RATE_LIMIT_WINDOW_MS + 1);
  assertEquals(result.current, 1, "Counter should reset after window expires");
});

Deno.test("checkRateLimitLocal: handles large microsecond deltas", () => {
  rateLimitMap.clear();

  const result1 = checkRateLimitLocal("test:user1", 0);
  assertEquals(result1.allowed, true);

  // Jump far ahead in time
  const result2 = checkRateLimitLocal("test:user1", Number.MAX_SAFE_INTEGER - 1);
  assertEquals(result2.allowed, true, "Should reset after large time jump");
  assertEquals(result2.current, 1);
});

Deno.test("checkRateLimitLocal: window size matches constant", () => {
  rateLimitMap.clear();
  const baseTime = 5000;

  const result = checkRateLimitLocal("test:user1", baseTime);
  const entry = rateLimitMap.get("uid:test:user1") || rateLimitMap.get("test:user1");

  if (entry) {
    assertEquals(
      entry.resetAt - baseTime,
      RATE_LIMIT_WINDOW_MS,
      "Window size should match constant",
    );
  }
});

Deno.test("extractKey: consistent for same JWT", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXItaWQifQ.signature";
  const key1 = extractKey(jwt);
  const key2 = extractKey(jwt);
  assertEquals(key1, key2, "Same JWT should always produce same key");
});
