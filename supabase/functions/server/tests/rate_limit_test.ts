/**
 * Tests for rate-limit.ts — Sliding window rate limiter.
 *
 * Run: deno test supabase/functions/server/tests/rate_limit_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkRateLimit,
  cleanupExpired,
  rateLimitMap,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from "../rate-limit.ts";

// Helper: reset state between tests
function resetRateLimit() {
  rateLimitMap.clear();
}

Deno.test("checkRateLimit: first request creates new window", () => {
  resetRateLimit();
  const result = checkRateLimit("user-1", 1000);
  assertEquals(result.allowed, true);
  assertEquals(result.current, 1);
  assertEquals(rateLimitMap.size, 1);
});

Deno.test("checkRateLimit: increments count within window", () => {
  resetRateLimit();
  const now = 1000;
  checkRateLimit("user-1", now);
  checkRateLimit("user-1", now + 100);
  const result = checkRateLimit("user-1", now + 200);
  assertEquals(result.allowed, true);
  assertEquals(result.current, 3);
});

Deno.test("checkRateLimit: blocks after max requests", () => {
  resetRateLimit();
  const now = 1000;

  // Fill up to max
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    const r = checkRateLimit("user-1", now + i);
    assertEquals(r.allowed, true);
  }

  // Next request should be blocked
  const blocked = checkRateLimit("user-1", now + RATE_LIMIT_MAX_REQUESTS);
  assertEquals(blocked.allowed, false);
  assertEquals(typeof blocked.retryAfterMs, "number");
});

Deno.test("checkRateLimit: resets after window expires", () => {
  resetRateLimit();
  const now = 1000;

  // Fill up to max
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    checkRateLimit("user-1", now);
  }

  // Should be blocked now
  assertEquals(checkRateLimit("user-1", now).allowed, false);

  // After window expires, should be allowed again
  const afterWindow = now + RATE_LIMIT_WINDOW_MS + 1;
  const result = checkRateLimit("user-1", afterWindow);
  assertEquals(result.allowed, true);
  assertEquals(result.current, 1);
});

Deno.test("checkRateLimit: different users have independent limits", () => {
  resetRateLimit();
  const now = 1000;

  // Fill user-1 to max
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    checkRateLimit("user-1", now);
  }
  assertEquals(checkRateLimit("user-1", now).allowed, false);

  // user-2 should still be allowed
  const result = checkRateLimit("user-2", now);
  assertEquals(result.allowed, true);
  assertEquals(result.current, 1);
});

Deno.test("cleanupExpired: removes expired entries", () => {
  resetRateLimit();
  const now = 1000;

  // Create entries with different expiry times
  checkRateLimit("old-user", now); // expires at now + WINDOW_MS
  checkRateLimit("new-user", now + RATE_LIMIT_WINDOW_MS + 500); // expires later

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
