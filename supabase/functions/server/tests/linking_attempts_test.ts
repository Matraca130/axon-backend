/**
 * Tests for routes/_messaging/linking-attempts.ts
 *
 * Covers the failure-tracking used by Telegram and WhatsApp verifyLinkCode
 * to lock out callers after repeated failed attempts (SEC-AUDIT defense-in-depth).
 *
 * Run: deno test supabase/functions/server/tests/linking_attempts_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createLinkingAttemptsTracker } from "../routes/_messaging/linking-attempts.ts";

const MAX = 5; // Must match MAX_FAILED_ATTEMPTS in linking-attempts.ts

Deno.test("allow: fresh key is allowed", () => {
  const t = createLinkingAttemptsTracker("test");
  assertEquals(t.allow("key-1"), true);
});

Deno.test("allow: unchanged by the allow() call itself (no mutation on read)", () => {
  const t = createLinkingAttemptsTracker("test");
  for (let i = 0; i < 100; i++) {
    assertEquals(t.allow("key-1"), true);
  }
  assertEquals(t.getMapSize(), 0);
});

Deno.test("recordFailure: first failure creates entry", () => {
  const t = createLinkingAttemptsTracker("test");
  t.recordFailure("key-1");
  assertEquals(t.getMapSize(), 1);
  assertEquals(t.allow("key-1"), true);
});

Deno.test("recordFailure: locks out after MAX failures", () => {
  const t = createLinkingAttemptsTracker("test");
  for (let i = 0; i < MAX - 1; i++) {
    t.recordFailure("key-1");
    assertEquals(t.allow("key-1"), true);
  }
  // MAX-th failure should push count to exactly MAX → subsequent allow() returns false.
  t.recordFailure("key-1");
  assertEquals(t.allow("key-1"), false);
});

Deno.test("recordFailure: keys are independent", () => {
  const t = createLinkingAttemptsTracker("test");
  for (let i = 0; i < MAX; i++) {
    t.recordFailure("attacker");
  }
  assertEquals(t.allow("attacker"), false);
  assertEquals(t.allow("victim"), true);
});

Deno.test("reset: clears lockout", () => {
  const t = createLinkingAttemptsTracker("test");
  for (let i = 0; i < MAX; i++) {
    t.recordFailure("key-1");
  }
  assertEquals(t.allow("key-1"), false);
  t.reset("key-1");
  assertEquals(t.allow("key-1"), true);
  assertEquals(t.getMapSize(), 0);
});

Deno.test("reset: is safe on unknown key", () => {
  const t = createLinkingAttemptsTracker("test");
  t.reset("never-seen");
  assertEquals(t.getMapSize(), 0);
});

Deno.test("getMapSize: tracks active entries only", () => {
  const t = createLinkingAttemptsTracker("test");
  assertEquals(t.getMapSize(), 0);
  t.recordFailure("a");
  t.recordFailure("b");
  assertEquals(t.getMapSize(), 2);
  t.reset("a");
  assertEquals(t.getMapSize(), 1);
});

Deno.test("independent tracker instances do not share state", () => {
  const a = createLinkingAttemptsTracker("A");
  const b = createLinkingAttemptsTracker("B");
  for (let i = 0; i < MAX; i++) a.recordFailure("shared-key");
  assertEquals(a.allow("shared-key"), false);
  assertEquals(b.allow("shared-key"), true);
});
