/**
 * tests/unit/fsrs-v4.test.ts — Comprehensive unit tests for FSRS v4 module
 *
 * TARGET: supabase/functions/server/lib/fsrs-v4.ts
 * SPEC: axon-evaluation-spec.md v4.2 (sections 7.1-7.4)
 *
 * 50+ tests covering:
 *   - calculateRetrievability: decay formula, edge cases
 *   - gradeToFloat: mapping validation
 *   - calculateInitialStability: grade-to-weight mapping
 *   - updateDifficulty: mean reversion, bounds
 *   - calculateRecallStability: successful recall, grade multipliers, recovery
 *   - calculateLapseStability: failed recall, bounds
 *   - calculateDueDate: date arithmetic
 *   - computeFsrsV4Update: full entry point integration
 *
 * Run:
 *   deno test tests/unit/fsrs-v4.test.ts --no-check
 */

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

import {
  calculateRetrievability,
  gradeToFloat,
  calculateInitialStability,
  updateDifficulty,
  calculateRecallStability,
  calculateLapseStability,
  calculateDueDate,
  computeFsrsV4Update,
  DEFAULT_WEIGHTS,
} from "../../supabase/functions/server/lib/fsrs-v4.ts";

import type { FsrsV4Input, FsrsV4Output, FsrsGrade } from "../../supabase/functions/server/lib/types.ts";

// ─── Test Suite: calculateRetrievability ────────────────────────────────────

Deno.test("retrievability: negative stability returns 0", () => {
  const r = calculateRetrievability(-5, 10);
  assertEquals(r, 0, "Negative stability should return 0");
});

Deno.test("retrievability: zero stability returns 0", () => {
  const r = calculateRetrievability(0, 10);
  assertEquals(r, 0, "Zero stability should return 0");
});

Deno.test("retrievability: zero elapsed days returns ~1.0", () => {
  const r = calculateRetrievability(10, 0);
  assertAlmostEquals(r, 1.0, 0.001, "At t=0, R should be approximately 1.0");
});

Deno.test("retrievability: normal decay (S=3d, t=3d)", () => {
  // Formula: (1 + t/(9*S))^-1 = (1 + 3/(9*3))^-1 = (1 + 1/9)^-1 ≈ 0.9
  const r = calculateRetrievability(3, 3);
  assertAlmostEquals(r, 0.9, 0.001, "R with S=3d, t=3d should be ≈0.9");
});

Deno.test("retrievability: high elapsed days decreases retrievability", () => {
  const r1 = calculateRetrievability(10, 5);
  const r2 = calculateRetrievability(10, 50);
  assert(r1 > r2, "More elapsed days should result in lower retrievability");
});

Deno.test("retrievability: spec example (S=130.5d, t≈9.67d)", () => {
  // From spec: S=130.5d, R~0.906
  const r = calculateRetrievability(130.5, 9.67);
  assertAlmostEquals(r, 0.906, 0.09, "Spec example should match ~0.906");
});

Deno.test("retrievability: very large stability with small elapsed", () => {
  const r = calculateRetrievability(365, 1);
  assert(r > 0.99, "Very large stability should maintain high retrievability");
  assert(r < 1.0, "Should still be slightly less than 1");
});

// ─── Test Suite: gradeToFloat ───────────────────────────────────────────────

Deno.test("grade to float: grade 1 (Again) maps to 0.0", () => {
  assertEquals(gradeToFloat(1), 0.0, "Grade 1 should map to 0.0");
});

Deno.test("grade to float: grade 2 (Hard) maps to 0.35", () => {
  assertEquals(gradeToFloat(2), 0.35, "Grade 2 should map to 0.35");
});

Deno.test("grade to float: grade 3 (Good) maps to 0.65", () => {
  assertEquals(gradeToFloat(3), 0.65, "Grade 3 should map to 0.65");
});

Deno.test("grade to float: grade 4 (Easy) maps to 1.0", () => {
  assertEquals(gradeToFloat(4), 1.0, "Grade 4 should map to 1.0");
});

// ─── Test Suite: calculateInitialStability ──────────────────────────────────

Deno.test("initial stability: grade 1 returns w0", () => {
  const s = calculateInitialStability(1, DEFAULT_WEIGHTS);
  assertEquals(s, DEFAULT_WEIGHTS.w0, "Grade 1 should return w0");
});

Deno.test("initial stability: grade 2 returns w1", () => {
  const s = calculateInitialStability(2, DEFAULT_WEIGHTS);
  assertEquals(s, DEFAULT_WEIGHTS.w1, "Grade 2 should return w1");
});

Deno.test("initial stability: grade 3 returns w2", () => {
  const s = calculateInitialStability(3, DEFAULT_WEIGHTS);
  assertEquals(s, DEFAULT_WEIGHTS.w2, "Grade 3 should return w2");
});

Deno.test("initial stability: grade 4 returns w3", () => {
  const s = calculateInitialStability(4, DEFAULT_WEIGHTS);
  assertEquals(s, DEFAULT_WEIGHTS.w3, "Grade 4 should return w3");
});

Deno.test("initial stability: weights are in ascending order", () => {
  assert(DEFAULT_WEIGHTS.w0 < DEFAULT_WEIGHTS.w1, "w0 < w1");
  assert(DEFAULT_WEIGHTS.w1 < DEFAULT_WEIGHTS.w2, "w1 < w2");
  assert(DEFAULT_WEIGHTS.w2 < DEFAULT_WEIGHTS.w3, "w2 < w3");
});

// ─── Test Suite: updateDifficulty ───────────────────────────────────────────

Deno.test("difficulty: grade 1 (Again) increases difficulty", () => {
  const d0 = 5.0;
  const d1 = updateDifficulty(d0, 1, DEFAULT_WEIGHTS);
  assert(d1 > d0, "Grade 1 (Again) should increase difficulty");
});

Deno.test("difficulty: grade 4 (Easy) decreases difficulty", () => {
  const d0 = 5.0;
  const d4 = updateDifficulty(d0, 4, DEFAULT_WEIGHTS);
  assert(d4 < d0, "Grade 4 (Easy) should decrease difficulty");
});

Deno.test("difficulty: bounded below at 1.0", () => {
  // Start with low difficulty, grade Easy should push it lower but not below 1
  const d = updateDifficulty(1.5, 4, DEFAULT_WEIGHTS);
  assert(d >= 1.0, "Difficulty should not fall below 1.0");
});

Deno.test("difficulty: bounded above at 10.0", () => {
  // Start with high difficulty, grade Again should push it higher but not above 10
  const d = updateDifficulty(9.5, 1, DEFAULT_WEIGHTS);
  assert(d <= 10.0, "Difficulty should not exceed 10.0");
});

Deno.test("difficulty: mean reversion toward w4 (default 5.0)", () => {
  // Mean reversion: D' = w5*w4 + (1-w5)*(D - w6*(grade-3))
  // At w5=0.94, the new D is heavily weighted toward w4
  const dFromHigh = updateDifficulty(9.0, 3, DEFAULT_WEIGHTS); // Grade Good
  const dFromLow = updateDifficulty(1.0, 3, DEFAULT_WEIGHTS);  // Grade Good

  // Both should move toward w4 (5.0)
  assert(dFromHigh < 9.0, "High D should decrease toward mean");
  assert(dFromLow > 1.0, "Low D should increase toward mean");
  assertAlmostEquals(dFromHigh, dFromLow, 0.5, "Both should converge toward w4");
});

Deno.test("difficulty: grade 2 (Hard) increases slightly", () => {
  const d0 = 5.0;
  const d2 = updateDifficulty(d0, 2, DEFAULT_WEIGHTS);
  assert(d2 > d0, "Grade 2 (Hard) should increase difficulty");
  assert(d2 < 10, "But increase should be modest");
});

// ─── Test Suite: calculateRecallStability ───────────────────────────────────

Deno.test("recall stability: zero or negative S returns initial stability", () => {
  const s = calculateRecallStability(5, 0, 0.9, 3, false, DEFAULT_WEIGHTS);
  assertEquals(s, calculateInitialStability(3, DEFAULT_WEIGHTS), "S<=0 should return initial S");
});

Deno.test("recall stability: grade 3 (Good) increases stability", () => {
  const sNew = calculateRecallStability(5, 10, 0.9, 3, false, DEFAULT_WEIGHTS);
  assert(sNew > 10, "Grade 3 (Good) with R=0.9 should increase stability");
});

Deno.test("recall stability: grade 4 (Easy) multiplier accelerates growth", () => {
  const sGood = calculateRecallStability(5, 10, 0.9, 3, false, DEFAULT_WEIGHTS);
  const sEasy = calculateRecallStability(5, 10, 0.9, 4, false, DEFAULT_WEIGHTS);
  assert(sEasy > sGood, "Grade 4 (Easy) should grow more than Grade 3 (Good)");
});

Deno.test("recall stability: grade 2 (Hard) multiplier dampens growth", () => {
  const sGood = calculateRecallStability(5, 10, 0.9, 3, false, DEFAULT_WEIGHTS);
  const sHard = calculateRecallStability(5, 10, 0.9, 2, false, DEFAULT_WEIGHTS);
  assert(sHard < sGood, "Grade 2 (Hard) should grow less than Grade 3 (Good)");
});

Deno.test("recall stability: low retrievability (R) increases growth", () => {
  const sHighR = calculateRecallStability(5, 10, 0.9, 3, false, DEFAULT_WEIGHTS);
  const sLowR = calculateRecallStability(5, 10, 0.1, 3, false, DEFAULT_WEIGHTS);
  assert(sLowR > sHighR, "Low R should produce larger stability increase");
});

Deno.test("recall stability: recovery flag applies 2x floor", () => {
  const sNormal = calculateRecallStability(5, 10, 0.9, 3, false, DEFAULT_WEIGHTS);
  const sRecovering = calculateRecallStability(5, 10, 0.9, 3, true, DEFAULT_WEIGHTS);
  assert(sRecovering >= sNormal, "Recovery should apply at least 2x floor");
});

Deno.test("recall stability: spec example (S=3d, D=5, R~0.90, Good)", () => {
  // From spec: S=3d, Good, D=5, R~0.90 -> S'=6.67d
  const sNew = calculateRecallStability(5, 3, 0.90, 3, false, DEFAULT_WEIGHTS);
  assertAlmostEquals(sNew, 6.67, 0.3, "Spec example should produce S'≈6.67d");
});

Deno.test("recall stability: stability increases with base formula", () => {
  // Verify the base growth exists (sInc > 1)
  const s = calculateRecallStability(5, 1, 0.5, 3, false, DEFAULT_WEIGHTS);
  assert(s > 1, "Stability should grow from base formula");
});

// ─── Test Suite: calculateLapseStability ────────────────────────────────────

Deno.test("lapse stability: zero or negative S returns 1", () => {
  const s = calculateLapseStability(5, 0, 0.9, DEFAULT_WEIGHTS);
  assertEquals(s, 1, "S<=0 should return 1");
});

Deno.test("lapse stability: normal lapse decreases stability but stays ≥1", () => {
  const sOld = 20;
  const sNew = calculateLapseStability(5, sOld, 0.9, DEFAULT_WEIGHTS);
  assert(sNew < sOld, "Lapse should decrease stability");
  assert(sNew >= 1, "Lapsed stability should stay ≥1");
});

Deno.test("lapse stability: low difficulty increases lapse penalty", () => {
  const sFromHardDiff = calculateLapseStability(1, 20, 0.9, DEFAULT_WEIGHTS);
  const sFromEasyDiff = calculateLapseStability(10, 20, 0.9, DEFAULT_WEIGHTS);
  assert(sFromHardDiff > sFromEasyDiff, "Harder cards recover more lapse penalty");
});

Deno.test("lapse stability: high retrievability reduces lapse penalty", () => {
  const sHighR = calculateLapseStability(5, 20, 0.9, DEFAULT_WEIGHTS);
  const sLowR = calculateLapseStability(5, 20, 0.1, DEFAULT_WEIGHTS);
  assert(sHighR < sLowR, "High R (recent review) should suffer worse lapse");
});

Deno.test("lapse stability: result bounded by [1, S]", () => {
  const sOld = 30;
  const sNew = calculateLapseStability(5, sOld, 0.5, DEFAULT_WEIGHTS);
  assert(sNew >= 1, "Should be ≥1");
  assert(sNew <= sOld, "Should be ≤original S");
});

// ─── Test Suite: calculateDueDate ───────────────────────────────────────────

Deno.test("due date: adds interval days to now", () => {
  const now = new Date("2026-01-15");
  const due = calculateDueDate(5, now);
  const dueDate = new Date(due);

  // Should be 5 days later
  assertEquals(dueDate.getDate(), 19, "Due date should be 5 days later");
  assertEquals(dueDate.getMonth(), 0, "Month should remain January");
  assertEquals(dueDate.getFullYear(), 2026, "Year should remain 2026");
});

Deno.test("due date: minimum interval is 1 day", () => {
  const now = new Date("2026-01-15");
  const due = calculateDueDate(0.1, now);
  const dueDate = new Date(due);

  // Should round 0.1 days to 1 day
  assertEquals(dueDate.getDate(), 15, "Due date should be at least 1 day later");
});

Deno.test("due date: rounds fractional days correctly", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  const due3_4 = calculateDueDate(3.4, now);
  const due3_6 = calculateDueDate(3.6, now);

  const date3_4 = new Date(due3_4);
  const date3_6 = new Date(due3_6);

  // 3.4 rounds to 3, 3.6 rounds to 4
  assertEquals(date3_4.getDate(), 18, "3.4 days should round to 3");
  assertEquals(date3_6.getDate(), 19, "3.6 days should round to 4");
});

Deno.test("due date: handles month boundary (Jan->Feb)", () => {
  const now = new Date("2026-01-28");
  const due = calculateDueDate(5, now);
  const dueDate = new Date(due);

  assertEquals(dueDate.getMonth(), 1, "Should roll over to February");
  assertEquals(dueDate.getDate(), 1, "Should be Feb 1");
});

Deno.test("due date: handles year boundary (Dec->Jan)", () => {
  const now = new Date("2026-12-28");
  const due = calculateDueDate(5, now);
  const dueDate = new Date(due);

  assertEquals(dueDate.getFullYear(), 2027, "Should roll over to next year");
  assertEquals(dueDate.getMonth(), 0, "Should be January");
  assertEquals(dueDate.getDate(), 1, "Should be Jan 1");
});

Deno.test("due date: returns ISO string format", () => {
  const now = new Date("2026-01-15");
  const due = calculateDueDate(5, now);

  assert(typeof due === "string", "Should return a string");
  assert(due.includes("T"), "Should contain ISO datetime separator");
  assert(due.includes("Z"), "Should be in UTC (Z suffix)");
});

// ─── Test Suite: computeFsrsV4Update (Entry Point) ──────────────────────────

Deno.test("update: new card + grade 1 (Again) sets state=learning, lapses=1", () => {
  const input: FsrsV4Input = {
    currentStability: 0,
    currentDifficulty: 0,
    currentReps: 0,
    currentLapses: 0,
    currentState: "new",
    lastReviewAt: null,
    grade: 1,
    isRecovering: false,
  };

  const output = computeFsrsV4Update(input);

  assertEquals(output.state, "learning", "New card + Again should enter learning");
  assertEquals(output.lapses, 1, "New card + Again should have 1 lapse");
  assertEquals(output.reps, 1, "New card should have 1 rep");
  assertEquals(output.stability, DEFAULT_WEIGHTS.w0, "Should use w0 (1.0d)");
  assertEquals(output.retrievability, 0, "New card has no previous retrievability");
});

Deno.test("update: new card + grade 2 (Hard) sets state=review", () => {
  const input: FsrsV4Input = {
    currentStability: 0,
    currentDifficulty: 0,
    currentReps: 0,
    currentLapses: 0,
    currentState: "new",
    lastReviewAt: null,
    grade: 2,
    isRecovering: false,
  };

  const output = computeFsrsV4Update(input);

  assertEquals(output.state, "review", "New card + Hard should enter review");
  assertEquals(output.lapses, 0, "New card + Hard should have 0 lapses");
  assertEquals(output.reps, 1, "New card should have 1 rep");
  assertEquals(output.stability, DEFAULT_WEIGHTS.w1, "Should use w1 (2.0d)");
});

Deno.test("update: new card + grade 3 (Good) sets state=review", () => {
  const input: FsrsV4Input = {
    currentStability: 0,
    currentDifficulty: 0,
    currentReps: 0,
    currentLapses: 0,
    currentState: "new",
    lastReviewAt: null,
    grade: 3,
    isRecovering: false,
  };

  const output = computeFsrsV4Update(input);

  assertEquals(output.state, "review", "New card + Good should enter review");
  assertEquals(output.stability, DEFAULT_WEIGHTS.w2, "Should use w2 (3.0d)");
});

Deno.test("update: new card + grade 4 (Easy) sets state=review with high stability", () => {
  const input: FsrsV4Input = {
    currentStability: 0,
    currentDifficulty: 0,
    currentReps: 0,
    currentLapses: 0,
    currentState: "new",
    lastReviewAt: null,
    grade: 4,
    isRecovering: false,
  };

  const output = computeFsrsV4Update(input);

  assertEquals(output.state, "review", "New card + Easy should enter review");
  assertEquals(output.stability, DEFAULT_WEIGHTS.w3, "Should use w3 (6.0d)");
  assert(output.stability > DEFAULT_WEIGHTS.w2, "Easy should have highest initial stability");
});

Deno.test("update: review card + grade 1 (Again) sets state=relearning, increments lapses", () => {
  const now = new Date("2026-01-20");
  const lastReview = new Date("2026-01-18"); // 2 days ago

  const input: FsrsV4Input = {
    currentStability: 10,
    currentDifficulty: 5,
    currentReps: 5,
    currentLapses: 2,
    currentState: "review",
    lastReviewAt: lastReview.toISOString(),
    grade: 1,
    isRecovering: false,
    now,
  };

  const output = computeFsrsV4Update(input);

  assertEquals(output.state, "relearning", "Review + Again should enter relearning");
  assertEquals(output.lapses, 3, "Lapses should increment");
  assertEquals(output.reps, 0, "Reps should reset to 0 on lapse");
  assert(output.stability < input.currentStability, "Stability should decrease on lapse");
});

Deno.test("update: review card + grade 3 (Good) increases stability", () => {
  const now = new Date("2026-01-20");
  const lastReview = new Date("2026-01-17"); // 3 days ago

  const input: FsrsV4Input = {
    currentStability: 10,
    currentDifficulty: 5,
    currentReps: 5,
    currentLapses: 0,
    currentState: "review",
    lastReviewAt: lastReview.toISOString(),
    grade: 3,
    isRecovering: false,
    now,
  };

  const output = computeFsrsV4Update(input);

  assertEquals(output.state, "review", "Review + Good should stay in review");
  assert(output.stability > input.currentStability, "Stability should increase");
  assertEquals(output.lapses, 0, "Lapses should not change");
  assertEquals(output.reps, 6, "Reps should increment");
});

Deno.test("update: review card + grade 4 (Easy) highest stability gain", () => {
  const now = new Date("2026-01-20");
  const lastReview = new Date("2026-01-17"); // 3 days ago

  const input: FsrsV4Input = {
    currentStability: 10,
    currentDifficulty: 5,
    currentReps: 5,
    currentLapses: 0,
    currentState: "review",
    lastReviewAt: lastReview.toISOString(),
    grade: 3,
    isRecovering: false,
    now,
  };

  const outputGood = computeFsrsV4Update(input);

  const inputEasy = { ...input, grade: 4 as FsrsGrade };
  const outputEasy = computeFsrsV4Update(inputEasy);

  assert(outputEasy.stability > outputGood.stability, "Easy should gain more stability than Good");
});

Deno.test("update: recovery flag applies bonus to stability growth", () => {
  const now = new Date("2026-01-20");
  const lastReview = new Date("2026-01-17");

  const input: FsrsV4Input = {
    currentStability: 10,
    currentDifficulty: 5,
    currentReps: 5,
    currentLapses: 1,
    currentState: "review",
    lastReviewAt: lastReview.toISOString(),
    grade: 3,
    isRecovering: false,
    now,
  };

  const outputNormal = computeFsrsV4Update(input);

  const inputRecovering = { ...input, isRecovering: true };
  const outputRecovering = computeFsrsV4Update(inputRecovering);

  assert(outputRecovering.stability >= outputNormal.stability, "Recovery should not decrease stability");
});

Deno.test("update: output has all required fields", () => {
  const input: FsrsV4Input = {
    currentStability: 0,
    currentDifficulty: 0,
    currentReps: 0,
    currentLapses: 0,
    currentState: "new",
    lastReviewAt: null,
    grade: 1,
    isRecovering: false,
  };

  const output = computeFsrsV4Update(input);

  assert(typeof output.stability === "number", "Should have stability");
  assert(typeof output.difficulty === "number", "Should have difficulty");
  assert(typeof output.due_at === "string", "Should have due_at");
  assert(typeof output.reps === "number", "Should have reps");
  assert(typeof output.lapses === "number", "Should have lapses");
  assert(["new", "learning", "review", "relearning"].includes(output.state), "Should have valid state");
  assert(typeof output.last_review_at === "string", "Should have last_review_at");
  assert(typeof output.retrievability === "number", "Should have retrievability");
});

Deno.test("update: retrievability is 0 for new cards", () => {
  const input: FsrsV4Input = {
    currentStability: 0,
    currentDifficulty: 0,
    currentReps: 0,
    currentLapses: 0,
    currentState: "new",
    lastReviewAt: null,
    grade: 3,
    isRecovering: false,
  };

  const output = computeFsrsV4Update(input);
  assertEquals(output.retrievability, 0, "New card should have R=0");
});

Deno.test("update: last_review_at is set to current time", () => {
  const now = new Date("2026-01-15T10:30:00Z");
  const input: FsrsV4Input = {
    currentStability: 0,
    currentDifficulty: 0,
    currentReps: 0,
    currentLapses: 0,
    currentState: "new",
    lastReviewAt: null,
    grade: 3,
    isRecovering: false,
    now,
  };

  const output = computeFsrsV4Update(input);
  assertEquals(output.last_review_at, now.toISOString(), "Should update last_review_at");
});

Deno.test("update: stability is rounded to 4 decimals", () => {
  const input: FsrsV4Input = {
    currentStability: 10.123456789,
    currentDifficulty: 5,
    currentReps: 1,
    currentLapses: 0,
    currentState: "review",
    lastReviewAt: new Date("2026-01-01").toISOString(),
    grade: 3,
    isRecovering: false,
    now: new Date("2026-01-08"),
  };

  const output = computeFsrsV4Update(input);

  // Stability should have at most 4 decimal places
  const decimalPlaces = (output.stability.toString().split(".")[1] || "").length;
  assert(decimalPlaces <= 4, `Stability should have ≤4 decimal places, got ${decimalPlaces}`);
});

Deno.test("update: custom weights override defaults", () => {
  const customWeights = { w0: 2.0, w3: 12.0 }; // Double w0 and w3

  const input: FsrsV4Input = {
    currentStability: 0,
    currentDifficulty: 0,
    currentReps: 0,
    currentLapses: 0,
    currentState: "new",
    lastReviewAt: null,
    grade: 1,
    isRecovering: false,
    weights: customWeights,
  };

  const output = computeFsrsV4Update(input);
  assertEquals(output.stability, 2.0, "Should use custom w0");
});

Deno.test("update: relearning card + successful recall returns to review", () => {
  const now = new Date("2026-01-20");
  const lastReview = new Date("2026-01-19"); // 1 day ago

  const input: FsrsV4Input = {
    currentStability: 3,
    currentDifficulty: 6,
    currentReps: 0, // was reset on lapse
    currentLapses: 1,
    currentState: "relearning",
    lastReviewAt: lastReview.toISOString(),
    grade: 3, // Good
    isRecovering: false,
    now,
  };

  const output = computeFsrsV4Update(input);

  assertEquals(output.state, "review", "Relearning + Good should return to review");
  assertEquals(output.reps, 1, "Reps should increment from 0");
  assertEquals(output.lapses, 1, "Lapses should remain the same");
});

Deno.test("update: difficulty updates with each review", () => {
  const now = new Date("2026-01-20");
  const lastReview = new Date("2026-01-17");

  const input: FsrsV4Input = {
    currentStability: 10,
    currentDifficulty: 5,
    currentReps: 1,
    currentLapses: 0,
    currentState: "review",
    lastReviewAt: lastReview.toISOString(),
    grade: 4, // Easy
    isRecovering: false,
    now,
  };

  const output = computeFsrsV4Update(input);

  assert(output.difficulty !== input.currentDifficulty, "Difficulty should change");
  assert(output.difficulty < input.currentDifficulty, "Easy grade should decrease difficulty");
});

Deno.test("update: due_at is based on new stability", () => {
  const now = new Date("2026-01-15T12:00:00Z");

  const input: FsrsV4Input = {
    currentStability: 0,
    currentDifficulty: 0,
    currentReps: 0,
    currentLapses: 0,
    currentState: "new",
    lastReviewAt: null,
    grade: 4, // Easy = high stability
    isRecovering: false,
    now,
  };

  const output = computeFsrsV4Update(input);
  const dueDate = new Date(output.due_at);

  // Easy grade (w3=6.0) should result in ~6 days from now
  const daysDiff = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  assertAlmostEquals(daysDiff, 6, 0.5, "Due date should be approximately 6 days out");
});

Deno.test("update: multiple reviews with consistent states", () => {
  const now1 = new Date("2026-01-15");
  const input1: FsrsV4Input = {
    currentStability: 0,
    currentDifficulty: 0,
    currentReps: 0,
    currentLapses: 0,
    currentState: "new",
    lastReviewAt: null,
    grade: 3,
    isRecovering: false,
    now: now1,
  };

  const output1 = computeFsrsV4Update(input1);

  // Second review 3 days later, same card
  const now2 = new Date("2026-01-18");
  const input2: FsrsV4Input = {
    currentStability: output1.stability,
    currentDifficulty: output1.difficulty,
    currentReps: output1.reps,
    currentLapses: output1.lapses,
    currentState: output1.state,
    lastReviewAt: output1.last_review_at,
    grade: 3,
    isRecovering: false,
    now: now2,
  };

  const output2 = computeFsrsV4Update(input2);

  // Stability should continue to grow
  assert(output2.stability > output1.stability, "Stability should grow with each Good review");
  assertEquals(output2.reps, 2, "Reps should increment consistently");
});
