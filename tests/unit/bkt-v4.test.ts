/**
 * tests/unit/bkt-v4.test.ts — 33 comprehensive unit tests for BKT v4
 *
 * Coverage:
 *   - calculateRecoveryMultiplier (6 tests)
 *   - getTypeMultiplier (2 tests)
 *   - updateMastery (7 tests)
 *   - updateMaxMastery (3 tests)
 *   - calculateDisplayMastery (4 tests)
 *   - computeBktV4Update (11 tests) — ENTRY POINT
 *
 * Run: deno test tests/unit/bkt-v4.test.ts --no-check
 *
 * Reference: axon-evaluation-spec.md v4.2, section 6.1
 * Spec Formulas:
 *   Correct:   new = cur + (1-cur) * P_LEARN * typeMult * recoveryMult
 *   Incorrect: new = cur * (1 - P_FORGET) = cur * 0.75
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/assert_almost_equals.ts";

import {
  calculateRecoveryMultiplier,
  getTypeMultiplier,
  updateMastery,
  updateMaxMastery,
  calculateDisplayMastery,
  computeBktV4Update,
} from "../../supabase/functions/server/lib/bkt-v4.ts";

import { BKT_PARAMS } from "../../supabase/functions/server/lib/types.ts";
import type { BktV4Input } from "../../supabase/functions/server/lib/types.ts";

// ═══════════════════════════════════════════════════════════════════════════
// calculateRecoveryMultiplier — Tests 1-6
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("calculateRecoveryMultiplier: maxReached > 0.50 AND current < maxReached → recovering=true, multiplier=3.0", () => {
  const result = calculateRecoveryMultiplier(0.40, 0.75);
  assertEquals(result.multiplier, 3.0, "Should return RECOVERY_FACTOR=3.0");
  assertEquals(result.isRecovering, true, "Should be recovering");
});

Deno.test("calculateRecoveryMultiplier: maxReached <= 0.50 → recovering=false, multiplier=1.0", () => {
  const result = calculateRecoveryMultiplier(0.30, 0.50);
  assertEquals(result.multiplier, 1.0, "Should return normal multiplier 1.0");
  assertEquals(result.isRecovering, false, "Should not be recovering");
});

Deno.test("calculateRecoveryMultiplier: current >= maxReached → recovering=false, multiplier=1.0", () => {
  const result = calculateRecoveryMultiplier(0.80, 0.75);
  assertEquals(result.multiplier, 1.0, "Should return normal multiplier 1.0");
  assertEquals(result.isRecovering, false, "Should not be recovering (no decline to recover from)");
});

Deno.test("calculateRecoveryMultiplier: edge case maxReached exactly 0.50 → NOT recovering", () => {
  const result = calculateRecoveryMultiplier(0.40, 0.50);
  assertEquals(result.multiplier, 1.0, "Should return 1.0 (threshold not exceeded)");
  assertEquals(result.isRecovering, false, "Should NOT be recovering at exactly 0.50");
});

Deno.test("calculateRecoveryMultiplier: edge case current=0, maxReached=0.8 → recovering", () => {
  const result = calculateRecoveryMultiplier(0, 0.8);
  assertEquals(result.multiplier, 3.0, "Should return 3.0");
  assertEquals(result.isRecovering, true, "Should be recovering (0 < 0.8)");
});

Deno.test("calculateRecoveryMultiplier: current=1, maxReached=0.9 → NOT recovering (current >= max)", () => {
  const result = calculateRecoveryMultiplier(1, 0.9);
  assertEquals(result.multiplier, 1.0, "Should return 1.0");
  assertEquals(result.isRecovering, false, "Should not be recovering (already back to mastery)");
});

// ═══════════════════════════════════════════════════════════════════════════
// getTypeMultiplier — Tests 7-8
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("getTypeMultiplier: quiz type returns QUIZ_MULTIPLIER", () => {
  const result = getTypeMultiplier("quiz");
  assertEquals(result, BKT_PARAMS.QUIZ_MULTIPLIER, "Should return quiz multiplier");
  assertEquals(result, 0.70, "Quiz multiplier should be 0.70");
});

Deno.test("getTypeMultiplier: flashcard type returns FLASHCARD_MULTIPLIER", () => {
  const result = getTypeMultiplier("flashcard");
  assertEquals(result, BKT_PARAMS.FLASHCARD_MULTIPLIER, "Should return flashcard multiplier");
  assertEquals(result, 1.00, "Flashcard multiplier should be 1.00");
});

// ═══════════════════════════════════════════════════════════════════════════
// updateMastery — Tests 9-15
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("updateMastery: correct answer with normal multipliers → mastery increases", () => {
  // Formula: new = cur + (1-cur) * P_LEARN * typeMultiplier * recoveryMultiplier
  // new = 0.30 + (1-0.30) * 0.18 * 0.70 * 1.0
  // new = 0.30 + 0.70 * 0.18 * 0.70
  // new = 0.30 + 0.0882 = 0.3882
  const current = 0.30;
  const result = updateMastery(current, true, 0.70, 1.0);

  const expected = 0.30 + (1 - 0.30) * 0.18 * 0.70 * 1.0;
  assertAlmostEquals(result, expected, 0.001, "Correct answer should increase mastery");
  assert(result > current, "Result should be greater than current");
});

Deno.test("updateMastery: incorrect answer → mastery decays by (1 - P_FORGET) = 0.75x", () => {
  // Formula: new = cur * (1 - P_FORGET) = cur * 0.75
  // new = 0.60 * 0.75 = 0.45
  const current = 0.60;
  const result = updateMastery(current, false, 0.70, 1.0);

  const expected = 0.60 * 0.75;
  assertAlmostEquals(result, expected, 0.0001, "Incorrect answer should multiply by 0.75");
  assert(result < current, "Result should be less than current");
});

Deno.test("updateMastery: clamping at 0 → very low mastery + incorrect stays >= 0", () => {
  const current = 0.01;
  const result = updateMastery(current, false, 1.0, 1.0);

  const expected = 0.01 * 0.75;
  assertAlmostEquals(result, expected, 0.0001, "Result should be 0.01 * 0.75 = 0.0075");
  assert(result >= 0, "Result should never be negative");
});

Deno.test("updateMastery: clamping at 1 → very high mastery + correct stays <= 1", () => {
  const current = 0.99;
  const result = updateMastery(current, true, 1.0, 1.0);

  // new = 0.99 + (1-0.99) * 0.18 * 1.0 * 1.0
  // new = 0.99 + 0.01 * 0.18 = 0.99 + 0.0018 = 0.9918
  assertEquals(result, 0.9918, "Should calculate normally (result < 1)");
  assert(result <= 1, "Result should never exceed 1");
});

Deno.test("updateMastery: recovery multiplier 3x boost on correct answer", () => {
  const current = 0.40;
  const typeMultiplier = 0.70;

  // Without recovery: new = 0.40 + 0.60 * 0.18 * 0.70 * 1.0
  const withoutRecovery = updateMastery(current, true, typeMultiplier, 1.0);

  // With recovery: new = 0.40 + 0.60 * 0.18 * 0.70 * 3.0
  const withRecovery = updateMastery(current, true, typeMultiplier, 3.0);

  // Delta should be exactly 3x
  const deltaWithout = withoutRecovery - current;
  const deltaWith = withRecovery - current;

  assertAlmostEquals(deltaWith / deltaWithout, 3.0, 0.001, "Recovery multiplier should boost gain by 3x");
  assert(withRecovery > withoutRecovery, "Recovery should produce higher mastery");
});

Deno.test("updateMastery: type multiplier effect (quiz 0.70 vs flashcard 1.00)", () => {
  const current = 0.50;

  const withQuiz = updateMastery(current, true, 0.70, 1.0);
  const withFlashcard = updateMastery(current, true, 1.00, 1.0);

  assert(withFlashcard > withQuiz, "Flashcard multiplier should produce higher gain than quiz");
  assertAlmostEquals(
    (withFlashcard - current) / (withQuiz - current),
    1.00 / 0.70,
    0.001,
    "Gain ratio should match multiplier ratio"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// updateMaxMastery — Tests 16-18
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("updateMaxMastery: new mastery > current max → returns new mastery", () => {
  const result = updateMaxMastery(0.50, 0.75);
  assertEquals(result, 0.75, "Should return the higher value");
});

Deno.test("updateMaxMastery: new mastery < current max → returns current max", () => {
  const result = updateMaxMastery(0.80, 0.60);
  assertEquals(result, 0.80, "Should return the current max (unchanged)");
});

Deno.test("updateMaxMastery: new equals current max → returns max", () => {
  const result = updateMaxMastery(0.70, 0.70);
  assertEquals(result, 0.70, "Should return the value when equal");
});

// ═══════════════════════════════════════════════════════════════════════════
// calculateDisplayMastery — Tests 19-22
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("calculateDisplayMastery: product of mastery and retrievability", () => {
  const mastery = 0.80;
  const retrievability = 0.90;
  const result = calculateDisplayMastery(mastery, retrievability);

  const expected = 0.80 * 0.90;
  assertEquals(result, expected, "Should be product of inputs");
});

Deno.test("calculateDisplayMastery: clamped at 0 when product < 0 (shouldn't happen)", () => {
  // This test is theoretical; both inputs should be [0,1], but clamping protects
  const mastery = -0.10; // Shouldn't happen, but...
  const retrievability = 0.50;
  const result = calculateDisplayMastery(mastery, retrievability);

  assertEquals(result, 0, "Should clamp at 0");
  assert(result >= 0, "Result should never be negative");
});

Deno.test("calculateDisplayMastery: clamped at 1 when product > 1 (shouldn't happen)", () => {
  // Theoretical edge case
  const mastery = 1.10;
  const retrievability = 1.05;
  const result = calculateDisplayMastery(mastery, retrievability);

  assertEquals(result, 1, "Should clamp at 1");
  assert(result <= 1, "Result should never exceed 1");
});

Deno.test("calculateDisplayMastery: both zero → zero display", () => {
  const result = calculateDisplayMastery(0, 0.50);
  assertEquals(result, 0, "Zero mastery should give zero display");
});

// ═══════════════════════════════════════════════════════════════════════════
// computeBktV4Update — ENTRY POINT — Tests 23-34
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("computeBktV4Update: correct quiz answer with no recovery → normal mastery gain", () => {
  const input: BktV4Input = {
    currentMastery: 0.30,
    maxReachedMastery: 0.35,
    isCorrect: true,
    instrumentType: "quiz",
  };

  const output = computeBktV4Update(input);

  // new = 0.30 + (1-0.30) * 0.18 * 0.70 * 1.0
  // new = 0.30 + 0.0882 = 0.3882
  const expectedNew = 0.30 + (1 - 0.30) * 0.18 * 0.70 * 1.0;
  assertAlmostEquals(output.p_know, expectedNew, 0.001, "Mastery should increase");

  // max should update if new > old max
  assertEquals(output.max_p_know, Math.max(0.35, expectedNew), "Max should be updated");

  assertEquals(output.is_recovering, false, "Should not be recovering (max <= 0.50)");

  // delta = new - old
  assertAlmostEquals(output.delta, output.p_know - 0.30, 0.001, "Delta should be difference");
});

Deno.test("computeBktV4Update: correct flashcard answer → higher multiplier than quiz", () => {
  const quizInput: BktV4Input = {
    currentMastery: 0.40,
    maxReachedMastery: 0.45,
    isCorrect: true,
    instrumentType: "quiz",
  };

  const flashcardInput: BktV4Input = {
    currentMastery: 0.40,
    maxReachedMastery: 0.45,
    isCorrect: true,
    instrumentType: "flashcard",
  };

  const quizOutput = computeBktV4Update(quizInput);
  const flashcardOutput = computeBktV4Update(flashcardInput);

  assert(
    flashcardOutput.p_know > quizOutput.p_know,
    "Flashcard should produce higher mastery gain than quiz"
  );
});

Deno.test("computeBktV4Update: incorrect answer → mastery decays by 0.75x", () => {
  const input: BktV4Input = {
    currentMastery: 0.60,
    maxReachedMastery: 0.70,
    isCorrect: false,
    instrumentType: "quiz",
  };

  const output = computeBktV4Update(input);

  // new = 0.60 * 0.75 = 0.45
  const expectedNew = 0.60 * 0.75;
  assertAlmostEquals(output.p_know, expectedNew, 0.0001, "Should decay to 0.45");

  // max unchanged (new < old max)
  assertEquals(output.max_p_know, 0.70, "Max should remain unchanged");

  // delta should be negative
  assert(output.delta < 0, "Delta should be negative for incorrect");
});

Deno.test("computeBktV4Update: correct with recovery active (maxReached > 0.5, current < max) → 3x boost", () => {
  const input: BktV4Input = {
    currentMastery: 0.40,
    maxReachedMastery: 0.80, // > 0.50 AND > current
    isCorrect: true,
    instrumentType: "quiz",
  };

  const output = computeBktV4Update(input);

  // With recovery: new = 0.40 + (1-0.40) * 0.18 * 0.70 * 3.0
  const expectedNew = 0.40 + (1 - 0.40) * 0.18 * 0.70 * 3.0;
  assertAlmostEquals(output.p_know, expectedNew, 0.001, "Should apply 3x recovery boost");

  assertEquals(output.is_recovering, true, "Should be recovering");

  // Without recovery: new = 0.40 + (1-0.40) * 0.18 * 0.70 * 1.0
  const noRecoveryNew = 0.40 + (1 - 0.40) * 0.18 * 0.70 * 1.0;
  assert(output.p_know > noRecoveryNew, "Should boost beyond normal gain");
});

Deno.test("computeBktV4Update: recovery NOT active when maxReached <= 0.50", () => {
  const input: BktV4Input = {
    currentMastery: 0.30,
    maxReachedMastery: 0.50, // At threshold, not above
    isCorrect: true,
    instrumentType: "quiz",
  };

  const output = computeBktV4Update(input);

  // Normal gain (no recovery)
  const expectedNew = 0.30 + (1 - 0.30) * 0.18 * 0.70 * 1.0;
  assertAlmostEquals(output.p_know, expectedNew, 0.001, "Should NOT apply recovery");

  assertEquals(output.is_recovering, false, "Should not be recovering at threshold");
});

Deno.test("computeBktV4Update: recovery NOT active when current >= maxReached", () => {
  const input: BktV4Input = {
    currentMastery: 0.85,
    maxReachedMastery: 0.80, // < current
    isCorrect: true,
    instrumentType: "flashcard",
  };

  const output = computeBktV4Update(input);

  // Normal gain (no recovery, no decline to recover from)
  const expectedNew = 0.85 + (1 - 0.85) * 0.18 * 1.00 * 1.0;
  assertAlmostEquals(output.p_know, expectedNew, 0.001, "Should use normal multiplier");

  assertEquals(output.is_recovering, false, "Should not be recovering");
});

Deno.test("computeBktV4Update: delta calculation = output.mastery - input.mastery", () => {
  const input: BktV4Input = {
    currentMastery: 0.50,
    maxReachedMastery: 0.55,
    isCorrect: true,
    instrumentType: "quiz",
  };

  const output = computeBktV4Update(input);

  const expectedDelta = output.p_know - 0.50;
  assertAlmostEquals(output.delta, expectedDelta, 0.0001, "Delta should match calculated difference");
});

Deno.test("computeBktV4Update: input clamping [0,1] for currentMastery and maxReachedMastery", () => {
  const input: BktV4Input = {
    currentMastery: 1.50, // Out of range
    maxReachedMastery: -0.20, // Out of range
    isCorrect: true,
    instrumentType: "quiz",
  };

  const output = computeBktV4Update(input);

  // Should clamp: currentMastery = 1.0, maxReachedMastery = 0.0
  // new = 1.0 + (1-1.0) * 0.18 * 0.70 * 1.0 = 1.0 (no gain, already at max)
  assertEquals(output.p_know, 1.0, "Current should be clamped at 1.0");
  assertEquals(output.max_p_know, 1.0, "Max should be updated to 1.0");
});

Deno.test("computeBktV4Update: rounding to 4 decimal places", () => {
  const input: BktV4Input = {
    currentMastery: 0.123456,
    maxReachedMastery: 0.654321,
    isCorrect: true,
    instrumentType: "flashcard",
  };

  const output = computeBktV4Update(input);

  // Check that output values are rounded to 4 decimals
  // They should have at most 4 decimal places when represented
  const isRounded = (n: number) => {
    const rounded = Math.round(n * 10000) / 10000;
    return n === rounded;
  };

  assert(isRounded(output.p_know), "p_know should be rounded to 4 decimals");
  assert(isRounded(output.max_p_know), "max_p_know should be rounded to 4 decimals");
  assert(isRounded(output.delta), "delta should be rounded to 4 decimals");
});

Deno.test("computeBktV4Update: recovery triple-boost integration test", () => {
  // Comprehensive test: student had high mastery (0.90), forgot (now 0.55),
  // answers correctly on quiz → should get 3x boost
  const input: BktV4Input = {
    currentMastery: 0.55,
    maxReachedMastery: 0.90,
    isCorrect: true,
    instrumentType: "quiz",
  };

  const output = computeBktV4Update(input);

  // With recovery: new = 0.55 + (1-0.55) * 0.18 * 0.70 * 3.0
  const expectedWithRecovery = 0.55 + (1 - 0.55) * 0.18 * 0.70 * 3.0;

  assertAlmostEquals(output.p_know, expectedWithRecovery, 0.001, "Should apply full recovery boost");
  assertEquals(output.max_p_know, 0.90, "Max should stay at 0.90 (output < max)");
  assertEquals(output.is_recovering, true, "Should flag recovery active");

  // Gain should be ~3x what it would be without recovery
  const normalGain = (1 - 0.55) * 0.18 * 0.70 * 1.0;
  const recoveryGain = output.p_know - 0.55;
  assertAlmostEquals(recoveryGain / normalGain, 3.0, 0.001, "Gain multiplier should be exactly 3.0");
});

Deno.test("computeBktV4Update: max_p_know updates when new > old max", () => {
  const input: BktV4Input = {
    currentMastery: 0.70,
    maxReachedMastery: 0.65, // Current > old max
    isCorrect: true,
    instrumentType: "flashcard",
  };

  const output = computeBktV4Update(input);

  // new > old max, so max_p_know should equal new
  assert(output.p_know > 0.65, "New mastery should exceed old max");
  assertEquals(output.max_p_know, output.p_know, "Max should update to new mastery");
});

Deno.test("computeBktV4Update: max_p_know stays unchanged when new < old max", () => {
  const input: BktV4Input = {
    currentMastery: 0.50,
    maxReachedMastery: 0.80,
    isCorrect: false, // Will decrease
    instrumentType: "flashcard",
  };

  const output = computeBktV4Update(input);

  // Incorrect: new = 0.50 * 0.75 = 0.375 < 0.80
  assertEquals(output.max_p_know, 0.80, "Max should remain unchanged when new < old max");
});
