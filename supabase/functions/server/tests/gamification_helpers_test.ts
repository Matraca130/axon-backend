/**
 * Tests for gamification helper functions
 *
 * Tests cover:
 *   1. evaluateSimpleCondition: operator matrix
 *   2. GOAL_BONUS_XP: values and completeness
 *   3. Level thresholds: correct level for each XP range
 *   4. Edge cases: malformed conditions, missing fields
 *   5. evaluateCountBadge: whitelist rejection + unparseable conditions (D-6)
 *
 * These functions are now properly exported from routes/gamification/helpers.ts
 * (previously duplicated here because they were private in routes-gamification.tsx).
 *
 * Run: deno test supabase/functions/server/tests/gamification_helpers_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Environment Setup ───
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key-for-testing");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key-for-testing");

import {
  evaluateSimpleCondition,
  evaluateCountBadge,
  calculateLevel,
  GOAL_BONUS_XP,
  type TriggerConfig,
} from "../routes/gamification/helpers.ts";

// ═══════════════════════════════════════════════════════════════
// 1. evaluateSimpleCondition — Operator Matrix
// ═══════════════════════════════════════════════════════════════

Deno.test("evaluateSimpleCondition: >= operator", () => {
  assertEquals(evaluateSimpleCondition("total_xp >= 100", { total_xp: 100 }), true);
  assertEquals(evaluateSimpleCondition("total_xp >= 100", { total_xp: 200 }), true);
  assertEquals(evaluateSimpleCondition("total_xp >= 100", { total_xp: 99 }), false);
});

Deno.test("evaluateSimpleCondition: > operator", () => {
  assertEquals(evaluateSimpleCondition("total_xp > 100", { total_xp: 101 }), true);
  assertEquals(evaluateSimpleCondition("total_xp > 100", { total_xp: 100 }), false);
  assertEquals(evaluateSimpleCondition("total_xp > 100", { total_xp: 99 }), false);
});

Deno.test("evaluateSimpleCondition: <= operator", () => {
  assertEquals(evaluateSimpleCondition("total_xp <= 100", { total_xp: 100 }), true);
  assertEquals(evaluateSimpleCondition("total_xp <= 100", { total_xp: 50 }), true);
  assertEquals(evaluateSimpleCondition("total_xp <= 100", { total_xp: 101 }), false);
});

Deno.test("evaluateSimpleCondition: < operator", () => {
  assertEquals(evaluateSimpleCondition("total_xp < 100", { total_xp: 99 }), true);
  assertEquals(evaluateSimpleCondition("total_xp < 100", { total_xp: 100 }), false);
});

Deno.test("evaluateSimpleCondition: = operator", () => {
  assertEquals(evaluateSimpleCondition("current_level = 5", { current_level: 5 }), true);
  assertEquals(evaluateSimpleCondition("current_level = 5", { current_level: 4 }), false);
});

Deno.test("evaluateSimpleCondition: == operator", () => {
  assertEquals(evaluateSimpleCondition("current_level == 5", { current_level: 5 }), true);
  assertEquals(evaluateSimpleCondition("current_level == 5", { current_level: 6 }), false);
});

Deno.test("evaluateSimpleCondition: missing field defaults to 0", () => {
  assertEquals(evaluateSimpleCondition("total_xp >= 0", {}), true);
  assertEquals(evaluateSimpleCondition("total_xp > 0", {}), false);
  assertEquals(evaluateSimpleCondition("total_xp = 0", {}), true);
});

Deno.test("evaluateSimpleCondition: malformed condition returns false", () => {
  assertEquals(evaluateSimpleCondition("", {}), false);
  assertEquals(evaluateSimpleCondition("invalid", {}), false);
  assertEquals(evaluateSimpleCondition("field ?? 5", {}), false);
  assertEquals(evaluateSimpleCondition("COUNT(*) >= 5", {}), false);
  assertEquals(evaluateSimpleCondition("field >= abc", {}), false);
});

Deno.test("evaluateSimpleCondition: decimal values", () => {
  assertEquals(evaluateSimpleCondition("p_know >= 0.95", { p_know: 0.96 }), true);
  assertEquals(evaluateSimpleCondition("p_know >= 0.95", { p_know: 0.94 }), false);
  assertEquals(evaluateSimpleCondition("p_know >= 0.95", { p_know: 0.95 }), true);
});

// ═══════════════════════════════════════════════════════════════
// 2. Level Thresholds
// ═══════════════════════════════════════════════════════════════

Deno.test("calculateLevel: 0 XP = level 1", () => {
  assertEquals(calculateLevel(0), 1);
});

Deno.test("calculateLevel: 99 XP = level 1 (under 100 threshold)", () => {
  assertEquals(calculateLevel(99), 1);
});

Deno.test("calculateLevel: 100 XP = level 2", () => {
  assertEquals(calculateLevel(100), 2);
});

Deno.test("calculateLevel: boundary values for all levels", () => {
  assertEquals(calculateLevel(100), 2);
  assertEquals(calculateLevel(300), 3);
  assertEquals(calculateLevel(600), 4);
  assertEquals(calculateLevel(1000), 5);
  assertEquals(calculateLevel(1500), 6);
  assertEquals(calculateLevel(2200), 7);
  assertEquals(calculateLevel(3000), 8);
  assertEquals(calculateLevel(4000), 9);
  assertEquals(calculateLevel(5500), 10);
  assertEquals(calculateLevel(7500), 11);
  assertEquals(calculateLevel(10000), 12);
});

Deno.test("calculateLevel: above max threshold still returns 12", () => {
  assertEquals(calculateLevel(99999), 12);
  assertEquals(calculateLevel(1000000), 12);
});

Deno.test("calculateLevel: just below each threshold", () => {
  assertEquals(calculateLevel(99), 1);
  assertEquals(calculateLevel(299), 2);
  assertEquals(calculateLevel(599), 3);
  assertEquals(calculateLevel(999), 4);
  assertEquals(calculateLevel(1499), 5);
  assertEquals(calculateLevel(2199), 6);
  assertEquals(calculateLevel(2999), 7);
  assertEquals(calculateLevel(3999), 8);
  assertEquals(calculateLevel(5499), 9);
  assertEquals(calculateLevel(7499), 10);
  assertEquals(calculateLevel(9999), 11);
});

// ═══════════════════════════════════════════════════════════════
// 3. GOAL_BONUS_XP Constants
// ═══════════════════════════════════════════════════════════════

Deno.test("GOAL_BONUS_XP: contains all 5 goal types", () => {
  assertEquals(Object.keys(GOAL_BONUS_XP).sort(), [
    "complete_session",
    "daily_xp",
    "review_due",
    "study_time",
    "weak_area",
  ]);
});

Deno.test("GOAL_BONUS_XP: weak_area has highest bonus (75 XP)", () => {
  const max = Math.max(...Object.values(GOAL_BONUS_XP));
  assertEquals(GOAL_BONUS_XP.weak_area, max);
  assertEquals(GOAL_BONUS_XP.weak_area, 75);
});

Deno.test("GOAL_BONUS_XP: all values are positive", () => {
  for (const [key, val] of Object.entries(GOAL_BONUS_XP)) {
    assertEquals(
      val > 0,
      true,
      `${key} bonus must be positive, got ${val}`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════
// 4. evaluateCountBadge — Whitelist & Early Returns (D-6)
//
// These tests verify the whitelist guard and unparseable condition
// paths. No DB connection is needed because these paths return
// false before any query is executed.
// ═══════════════════════════════════════════════════════════════

// deno-lint-ignore no-explicit-any
const fakeDb = {} as any;

Deno.test("evaluateCountBadge: rejects table not in ALLOWED_TABLES", async () => {
  const config: TriggerConfig = {
    table: "nonexistent_table",
    condition: "COUNT(*) >= 1",
  };
  const result = await evaluateCountBadge(fakeDb, "student-1", config);
  assertEquals(result, false);
});

Deno.test("evaluateCountBadge: rejects empty table name", async () => {
  const config: TriggerConfig = {
    table: "",
    condition: "COUNT(*) >= 1",
  };
  const result = await evaluateCountBadge(fakeDb, "student-1", config);
  assertEquals(result, false);
});

Deno.test("evaluateCountBadge: rejects ai_conversations (deactivated S3-004)", async () => {
  const config: TriggerConfig = {
    table: "ai_conversations",
    condition: "COUNT(*) >= 1",
  };
  const result = await evaluateCountBadge(fakeDb, "student-1", config);
  assertEquals(result, false);
});

Deno.test("evaluateCountBadge: rejects leaderboard_weekly (deactivated S3-004)", async () => {
  const config: TriggerConfig = {
    table: "leaderboard_weekly",
    condition: "rank <= 10",
  };
  const result = await evaluateCountBadge(fakeDb, "student-1", config);
  assertEquals(result, false);
});

Deno.test("evaluateCountBadge: rejects flashcards table (no student_id)", async () => {
  const config: TriggerConfig = {
    table: "flashcards",
    condition: "COUNT(*) >= 10",
  };
  const result = await evaluateCountBadge(fakeDb, "student-1", config);
  assertEquals(result, false);
});

Deno.test("evaluateCountBadge: rejects unparseable condition on whitelisted table", async () => {
  // study_sessions IS in the whitelist, but the condition is garbage.
  // The 3 regex patterns all fail, so it falls through to the
  // warning + return false — no DB query is attempted.
  const config: TriggerConfig = {
    table: "study_sessions",
    condition: "INVALID!!CONDITION",
  };
  const result = await evaluateCountBadge(fakeDb, "student-1", config);
  assertEquals(result, false);
});

Deno.test("evaluateCountBadge: rejects empty condition on whitelisted table", async () => {
  const config: TriggerConfig = {
    table: "study_sessions",
    condition: "",
  };
  const result = await evaluateCountBadge(fakeDb, "student-1", config);
  assertEquals(result, false);
});
