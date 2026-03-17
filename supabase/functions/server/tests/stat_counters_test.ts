/**
 * Tests for stat-counters pure helpers
 *
 * Tests cover:
 *   1. VALID_STAT_FIELDS whitelist
 *   2. isValidStatField validation
 *
 * Run: deno test supabase/functions/server/tests/stat_counters_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  VALID_STAT_FIELDS,
  isValidStatField,
} from "../stat-counters.ts";

// === VALID_STAT_FIELDS ===

Deno.test("VALID_STAT_FIELDS: has exactly 4 fields", () => {
  assertEquals(VALID_STAT_FIELDS.length, 4);
});

Deno.test("VALID_STAT_FIELDS: includes reviews_today", () => {
  assertEquals(VALID_STAT_FIELDS.includes("reviews_today"), true);
});

Deno.test("VALID_STAT_FIELDS: includes sessions_today", () => {
  assertEquals(VALID_STAT_FIELDS.includes("sessions_today"), true);
});

Deno.test("VALID_STAT_FIELDS: includes correct_streak", () => {
  assertEquals(VALID_STAT_FIELDS.includes("correct_streak"), true);
});

Deno.test("VALID_STAT_FIELDS: includes challenges_completed", () => {
  assertEquals(VALID_STAT_FIELDS.includes("challenges_completed"), true);
});

// === isValidStatField ===

Deno.test("isValidStatField: accepts all 4 valid fields", () => {
  assertEquals(isValidStatField("reviews_today"), true);
  assertEquals(isValidStatField("sessions_today"), true);
  assertEquals(isValidStatField("correct_streak"), true);
  assertEquals(isValidStatField("challenges_completed"), true);
});

Deno.test("isValidStatField: rejects invalid fields", () => {
  assertEquals(isValidStatField("total_xp"), false);
  assertEquals(isValidStatField(""), false);
  assertEquals(isValidStatField("reviews_today; DROP TABLE student_stats"), false);
});

Deno.test("isValidStatField: rejects close-but-wrong names", () => {
  assertEquals(isValidStatField("reviews_Today"), false);
  assertEquals(isValidStatField("REVIEWS_TODAY"), false);
  assertEquals(isValidStatField("review_today"), false);
  assertEquals(isValidStatField("challenge_completed"), false);
});

Deno.test("isValidStatField: prevents SQL injection patterns", () => {
  assertEquals(isValidStatField("reviews_today OR 1=1"), false);
  assertEquals(isValidStatField("'; DROP TABLE --"), false);
});
