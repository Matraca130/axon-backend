// ============================================================
// tests/bkt_v4_test.ts — BKT v4 Recovery unit tests
// Run: deno test --allow-none supabase/functions/server/tests/bkt_v4_test.ts
// ============================================================

import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/assert_almost_equals.ts";
import { computeBktV4Update, calculateDisplayMastery } from "../lib/bkt-v4.ts";
import { BKT_PARAMS } from "../lib/types.ts";

// ── Parameters ──────────────────────────────────────────────

Deno.test("BKT params match spec §6.1", () => {
  assertEquals(BKT_PARAMS.P_LEARN, 0.18);
  assertEquals(BKT_PARAMS.P_FORGET, 0.25);
  assertEquals(BKT_PARAMS.RECOVERY_FACTOR, 3.0);
  assertEquals(BKT_PARAMS.MIN_MASTERY_FOR_RECOVERY, 0.50);
  assertEquals(BKT_PARAMS.QUIZ_MULTIPLIER, 0.70);
  assertEquals(BKT_PARAMS.FLASHCARD_MULTIPLIER, 1.00);
});

// ── Correct ─────────────────────────────────────────────────

Deno.test("First flashcard correct: 0 -> 0.18", () => {
  const out = computeBktV4Update({
    currentMastery: 0, maxReachedMastery: 0,
    isCorrect: true, instrumentType: "flashcard",
  });
  assertAlmostEquals(out.p_know, 0.18, 0.001);
  assertEquals(out.delta > 0, true);
  assertEquals(out.is_recovering, false);
});

Deno.test("First quiz correct: 0 -> 0.126 (x0.70)", () => {
  const out = computeBktV4Update({
    currentMastery: 0, maxReachedMastery: 0,
    isCorrect: true, instrumentType: "quiz",
  });
  assertAlmostEquals(out.p_know, 0.126, 0.001);
});

// ── Incorrect ───────────────────────────────────────────────

Deno.test("Incorrect reduces mastery by 25%", () => {
  const out = computeBktV4Update({
    currentMastery: 0.8, maxReachedMastery: 0.8,
    isCorrect: false, instrumentType: "flashcard",
  });
  assertAlmostEquals(out.p_know, 0.6, 0.001);
});

// ── Recovery ────────────────────────────────────────────────

Deno.test("Recovery: 3x boost when re-learning", () => {
  const out = computeBktV4Update({
    currentMastery: 0.3, maxReachedMastery: 0.8,
    isCorrect: true, instrumentType: "flashcard",
  });
  assertAlmostEquals(out.p_know, 0.678, 0.01);
  assertEquals(out.is_recovering, true);
});

Deno.test("Recovery: NOT active if max < 0.50", () => {
  const out = computeBktV4Update({
    currentMastery: 0.2, maxReachedMastery: 0.4,
    isCorrect: true, instrumentType: "flashcard",
  });
  assertEquals(out.is_recovering, false);
});

// ── max_p_know tracking ─────────────────────────────────────

Deno.test("max_p_know tracks peak", () => {
  const out = computeBktV4Update({
    currentMastery: 0.5, maxReachedMastery: 0.3,
    isCorrect: true, instrumentType: "flashcard",
  });
  assertEquals(out.max_p_know >= out.p_know, true);
});

Deno.test("max_p_know stays on drop", () => {
  const out = computeBktV4Update({
    currentMastery: 0.8, maxReachedMastery: 0.8,
    isCorrect: false, instrumentType: "flashcard",
  });
  assertEquals(out.max_p_know, 0.8);
});

// ── Progression tables (spec verification) ──────────────────

Deno.test("Quiz: 8 correct reviews -> ~0.70 mastery", () => {
  let m = 0, max = 0;
  for (let i = 0; i < 8; i++) {
    const out = computeBktV4Update({
      currentMastery: m, maxReachedMastery: max,
      isCorrect: true, instrumentType: "quiz",
    });
    m = out.p_know; max = out.max_p_know;
  }
  assertAlmostEquals(m, 0.70, 0.05);
});

Deno.test("Flashcard: 6 correct reviews -> ~0.70 mastery", () => {
  let m = 0, max = 0;
  for (let i = 0; i < 6; i++) {
    const out = computeBktV4Update({
      currentMastery: m, maxReachedMastery: max,
      isCorrect: true, instrumentType: "flashcard",
    });
    m = out.p_know; max = out.max_p_know;
  }
  assertAlmostEquals(m, 0.70, 0.05);
});

// ── Display Mastery ─────────────────────────────────────────

Deno.test("displayMastery = mastery * R", () => {
  const display = calculateDisplayMastery(0.8, 0.9);
  assertAlmostEquals(display, 0.72, 0.001);
});
