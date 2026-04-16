/**
 * tests/unit/e2e-gamification.test.ts — 22 tests for gamification subsystem
 *
 * Tests cover: XP engine, badge evaluation, streak logic, advisory locks,
 * level calculation, and the gamification dispatcher's lock key derivation.
 *
 * ZERO dependency on db.ts — runs without env vars.
 * Run: deno test tests/unit/e2e-gamification.test.ts --no-check
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

import {
  XP_TABLE,
  calculateLevel,
  LEVEL_THRESHOLDS,
} from "../../supabase/functions/server/xp-engine.ts";

import {
  evaluateSimpleCondition,
  FREEZE_COST_XP,
  MAX_FREEZES,
  REPAIR_BASE_COST_XP,
  GOAL_BONUS_XP,
} from "../../supabase/functions/server/routes/gamification/helpers.ts";

import {
  advisoryLockKey,
} from "../../supabase/functions/server/lib/advisory-lock.ts";

// ═══ XP TABLE — Action XP Values ═══

Deno.test("XP_TABLE contains all expected actions with positive values", () => {
  const expectedActions = [
    "review_flashcard", "review_correct", "quiz_answer", "quiz_correct",
    "complete_session", "complete_reading", "complete_video",
    "streak_daily", "complete_plan_task", "complete_plan", "rag_question",
  ];
  for (const action of expectedActions) {
    assert(action in XP_TABLE, `XP_TABLE missing action: ${action}`);
    assert(XP_TABLE[action] > 0, `XP_TABLE[${action}] must be positive`);
  }
});

Deno.test("XP_TABLE: complete_plan gives most XP (100)", () => {
  assertEquals(XP_TABLE.complete_plan, 100);
  for (const [action, xp] of Object.entries(XP_TABLE)) {
    if (action !== "complete_plan") {
      assert(xp < XP_TABLE.complete_plan, `${action} (${xp}) should be less than complete_plan`);
    }
  }
});

Deno.test("XP_TABLE: review_flashcard < review_correct (correct answers worth more)", () => {
  assert(XP_TABLE.review_flashcard < XP_TABLE.review_correct);
});

Deno.test("XP_TABLE: quiz_answer < quiz_correct (correct answers worth more)", () => {
  assert(XP_TABLE.quiz_answer < XP_TABLE.quiz_correct);
});

// ═══ LEVEL CALCULATION ═══

Deno.test("calculateLevel: 0 XP = level 1", () => {
  assertEquals(calculateLevel(0), 1);
});

Deno.test("calculateLevel: exact threshold boundaries", () => {
  assertEquals(calculateLevel(100), 2);
  assertEquals(calculateLevel(99), 1);
  assertEquals(calculateLevel(300), 3);
  assertEquals(calculateLevel(600), 4);
  assertEquals(calculateLevel(1000), 5);
  assertEquals(calculateLevel(10000), 12);
});

Deno.test("calculateLevel: level 12 is max (even with huge XP)", () => {
  assertEquals(calculateLevel(999999), 12);
  assertEquals(calculateLevel(10000), 12);
});

Deno.test("calculateLevel: negative XP returns level 1", () => {
  assertEquals(calculateLevel(-100), 1);
});

Deno.test("LEVEL_THRESHOLDS: sorted descending by XP", () => {
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    assert(
      LEVEL_THRESHOLDS[i - 1][0] > LEVEL_THRESHOLDS[i][0],
      `Threshold at ${i - 1} (${LEVEL_THRESHOLDS[i - 1][0]}) must be > threshold at ${i} (${LEVEL_THRESHOLDS[i][0]})`,
    );
  }
});

// ═══ BADGE CRITERIA EVALUATION — evaluateSimpleCondition ═══

Deno.test("evaluateSimpleCondition: total_xp >= 500 with 600 XP", () => {
  assert(evaluateSimpleCondition("total_xp >= 500", { total_xp: 600 }));
});

Deno.test("evaluateSimpleCondition: total_xp >= 500 with 499 XP", () => {
  assert(!evaluateSimpleCondition("total_xp >= 500", { total_xp: 499 }));
});

Deno.test("evaluateSimpleCondition: exact boundary total_xp >= 500 with 500 XP", () => {
  assert(evaluateSimpleCondition("total_xp >= 500", { total_xp: 500 }));
});

Deno.test("evaluateSimpleCondition: supports all operators (>, <, <=, =, ==)", () => {
  assert(evaluateSimpleCondition("current_streak > 7", { current_streak: 8 }));
  assert(!evaluateSimpleCondition("current_streak > 7", { current_streak: 7 }));
  assert(evaluateSimpleCondition("current_streak < 5", { current_streak: 4 }));
  assert(evaluateSimpleCondition("current_streak <= 5", { current_streak: 5 }));
  assert(evaluateSimpleCondition("current_level = 3", { current_level: 3 }));
  assert(evaluateSimpleCondition("current_level == 3", { current_level: 3 }));
});

Deno.test("evaluateSimpleCondition: missing field defaults to 0", () => {
  assert(evaluateSimpleCondition("total_reviews >= 0", {}));
  assert(!evaluateSimpleCondition("total_reviews >= 1", {}));
});

Deno.test("evaluateSimpleCondition: invalid condition returns false", () => {
  assert(!evaluateSimpleCondition("", { total_xp: 100 }));
  assert(!evaluateSimpleCondition("total_xp LIKE 100", { total_xp: 100 }));
  assert(!evaluateSimpleCondition("total_xp >= abc", { total_xp: 100 }));
});

Deno.test("evaluateSimpleCondition: decimal values work", () => {
  assert(evaluateSimpleCondition("total_xp >= 99.5", { total_xp: 100 }));
  assert(!evaluateSimpleCondition("total_xp >= 100.5", { total_xp: 100 }));
});

// ═══ GAMIFICATION CONSTANTS ═══

Deno.test("FREEZE_COST_XP is 100, MAX_FREEZES is 3, REPAIR_BASE_COST_XP is 200", () => {
  assertEquals(FREEZE_COST_XP, 100);
  assertEquals(MAX_FREEZES, 3);
  assertEquals(REPAIR_BASE_COST_XP, 200);
});

Deno.test("GOAL_BONUS_XP has positive values for all goal types", () => {
  const expectedGoals = ["review_due", "weak_area", "daily_xp", "study_time", "complete_session"];
  for (const goal of expectedGoals) {
    assert(goal in GOAL_BONUS_XP, `GOAL_BONUS_XP missing goal: ${goal}`);
    assert(GOAL_BONUS_XP[goal] > 0, `GOAL_BONUS_XP[${goal}] must be positive`);
  }
});

// ═══ ADVISORY LOCK KEY DERIVATION (Race Condition Handling) ═══

Deno.test("advisoryLockKey: deterministic hash (same input = same output)", () => {
  const hash1 = advisoryLockKey("student-123:post_eval");
  const hash2 = advisoryLockKey("student-123:post_eval");
  assertEquals(hash1, hash2);
});

Deno.test("advisoryLockKey: different inputs produce different hashes", () => {
  const hash1 = advisoryLockKey("student-123:post_eval");
  const hash2 = advisoryLockKey("student-456:post_eval");
  assert(hash1 !== hash2, "Different students should get different lock keys");
});

Deno.test("advisoryLockKey: returns positive 32-bit integer (safe for pg advisory lock)", () => {
  const inputs = ["test", "", "a".repeat(1000), "student-uuid-here:post_eval"];
  for (const input of inputs) {
    const hash = advisoryLockKey(input);
    assert(hash >= 0, `Hash for "${input.slice(0, 20)}..." must be >= 0`);
    assert(hash <= 0xFFFFFFFF, `Hash for "${input.slice(0, 20)}..." must be <= 2^32-1`);
    assert(Number.isInteger(hash), `Hash must be an integer`);
  }
});

Deno.test("advisoryLockKey: post_eval suffix produces consistent key", () => {
  const studentId = "550e8400-e29b-41d4-a716-446655440000";
  const key = advisoryLockKey(`${studentId}:post_eval`);
  const manual = advisoryLockKey(`${studentId}:post_eval`);
  assertEquals(key, manual);
});

// ═══ ADVISORY LOCK — Pinning Tests (FNV-1a 32-bit unsigned) ═══
// Pin exact hash values so any accidental algorithm change (e.g. switching
// back to djb2 or changing encoding) fails the suite. Regenerate via:
//   deno eval 'import {advisoryLockKey} from "./.../advisory-lock.ts"; console.log(advisoryLockKey("..."))'
Deno.test("advisoryLockKey: pinned value — empty string (FNV offset basis)", () => {
  assertEquals(advisoryLockKey(""), 2166136261); // 0x811c9dc5
});

Deno.test("advisoryLockKey: pinned value — 'test'", () => {
  assertEquals(advisoryLockKey("test"), 2949673445);
});

Deno.test("advisoryLockKey: pinned values — gamification lock key suffixes", () => {
  const studentId = "550e8400-e29b-41d4-a716-446655440000";
  assertEquals(advisoryLockKey(`${studentId}:post_eval`), 991361007);
  assertEquals(advisoryLockKey(`${studentId}:streak_freeze`), 3093196886);
  assertEquals(advisoryLockKey(`${studentId}:streak_repair`), 440929696);
});
