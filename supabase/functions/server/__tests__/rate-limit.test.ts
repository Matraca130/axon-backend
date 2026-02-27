import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkRateLimit,
  resetRateLimitStore,
} from "../rate-limit.ts";

Deno.test({
  name: "rate-limit: allows requests within limit",
  fn() {
    resetRateLimitStore();
    const config = { maxRequests: 3, windowMs: 60_000 };

    const r1 = checkRateLimit("test-allow-1", config);
    assertEquals(r1.allowed, true);
    assertEquals(r1.remaining, 2);

    const r2 = checkRateLimit("test-allow-1", config);
    assertEquals(r2.allowed, true);
    assertEquals(r2.remaining, 1);

    const r3 = checkRateLimit("test-allow-1", config);
    assertEquals(r3.allowed, true);
    assertEquals(r3.remaining, 0);
  },
});

Deno.test({
  name: "rate-limit: blocks requests over limit",
  fn() {
    resetRateLimitStore();
    const config = { maxRequests: 2, windowMs: 60_000 };

    checkRateLimit("test-block-1", config);
    checkRateLimit("test-block-1", config);

    const r3 = checkRateLimit("test-block-1", config);
    assertEquals(r3.allowed, false);
    assertEquals(r3.remaining, 0);
  },
});

Deno.test({
  name: "rate-limit: different keys are independent",
  fn() {
    resetRateLimitStore();
    const config = { maxRequests: 1, windowMs: 60_000 };

    const rA = checkRateLimit("key-indep-a", config);
    assertEquals(rA.allowed, true);

    const rB = checkRateLimit("key-indep-b", config);
    assertEquals(rB.allowed, true);

    const rA2 = checkRateLimit("key-indep-a", config);
    assertEquals(rA2.allowed, false);
  },
});

Deno.test({
  name: "rate-limit: window resets after expiry",
  fn() {
    resetRateLimitStore();
    const config = { maxRequests: 1, windowMs: 1 }; // 1ms window

    checkRateLimit("test-expiry-1", config);

    // Busy-wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* wait 10ms */
    }

    const r2 = checkRateLimit("test-expiry-1", config);
    assertEquals(r2.allowed, true);
  },
});
