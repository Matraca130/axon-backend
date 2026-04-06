/**
 * tests/unit/timing-safe.test.ts — Unit tests for constant-time comparison
 *
 * 22 tests covering:
 * - Identical strings (ASCII, UTF-8, long)
 * - Different strings (first/middle/last char differ, length mismatch)
 * - Edge cases (empty strings, single char, special chars, Unicode)
 * - Security: different input lengths return false fast
 *
 * Run:
 *   cd /sessions/great-bold-mccarthy/mnt/petri/AXON\ PROJECTO/backend
 *   deno test tests/unit/timing-safe.test.ts --allow-env --no-check
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { timingSafeEqual } from "../../supabase/functions/server/timing-safe.ts";

// ─── Happy Path: Identical Strings ──────────────────────────────────

Deno.test("timingSafeEqual: identical simple ASCII strings", () => {
  const result = timingSafeEqual("hello", "hello");
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: identical longer ASCII strings", () => {
  const result = timingSafeEqual(
    "The quick brown fox jumps over the lazy dog",
    "The quick brown fox jumps over the lazy dog"
  );
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: identical empty strings", () => {
  const result = timingSafeEqual("", "");
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: identical single character", () => {
  const result = timingSafeEqual("a", "a");
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: identical with numbers", () => {
  const result = timingSafeEqual("12345", "12345");
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: identical with special characters", () => {
  const result = timingSafeEqual("!@#$%^&*()", "!@#$%^&*()");
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: identical UTF-8 strings (accents)", () => {
  const result = timingSafeEqual("café", "café");
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: identical emoji strings", () => {
  const result = timingSafeEqual("😀😁😂", "😀😁😂");
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: identical with newlines and tabs", () => {
  const result = timingSafeEqual("hello\nworld\ttab", "hello\nworld\ttab");
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: identical JWT-like strings (base64)", () => {
  const jwt1 = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const result = timingSafeEqual(jwt1, jwt1);
  assertEquals(result, true);
});

// ─── Negative: Different Strings ────────────────────────────────────

Deno.test("timingSafeEqual: different simple strings", () => {
  const result = timingSafeEqual("hello", "world");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: first character differs", () => {
  const result = timingSafeEqual("apple", "ample");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: middle character differs", () => {
  const result = timingSafeEqual("hello", "hallo");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: last character differs", () => {
  const result = timingSafeEqual("hello", "hellow");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: case sensitive (uppercase differs)", () => {
  const result = timingSafeEqual("Hello", "hello");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: different UTF-8 characters", () => {
  const result = timingSafeEqual("café", "cafe");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: different emoji", () => {
  const result = timingSafeEqual("😀", "😁");
  assertEquals(result, false);
});

// ─── Length Mismatch (Security: Fast Return) ────────────────────────

Deno.test("timingSafeEqual: first string longer returns false", () => {
  const result = timingSafeEqual("hello world", "hello");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: second string longer returns false", () => {
  const result = timingSafeEqual("hello", "hello world");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: one empty, one non-empty returns false", () => {
  const result = timingSafeEqual("", "hello");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: length mismatch with UTF-8 (byte length differs)", () => {
  // "café" is 5 bytes in UTF-8, "cafe" is 4 bytes
  const result = timingSafeEqual("café", "cafe");
  assertEquals(result, false);
});

// ─── Edge Cases ─────────────────────────────────────────────────────

Deno.test("timingSafeEqual: both strings with spaces are identical", () => {
  const result = timingSafeEqual("  spaces  ", "  spaces  ");
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: single space differs from two spaces", () => {
  const result = timingSafeEqual(" ", "  ");
  assertEquals(result, false);
});

Deno.test("timingSafeEqual: very long identical strings", () => {
  const longStr = "a".repeat(10000);
  const result = timingSafeEqual(longStr, longStr);
  assertEquals(result, true);
});

Deno.test("timingSafeEqual: very long strings differing at end", () => {
  const str1 = "a".repeat(9999) + "b";
  const str2 = "a".repeat(10000);
  const result = timingSafeEqual(str1, str2);
  assertEquals(result, false);
});
