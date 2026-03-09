// ============================================================
// tests/fsrs_v4_test.ts — FSRS v4 Petrick unit tests
// Run: deno test --allow-none supabase/functions/server/tests/fsrs_v4_test.ts
// ============================================================

import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/assert_almost_equals.ts";
import {
  computeFsrsV4Update,
  calculateRetrievability,
  calculateInitialStability,
  calculateRecallStability,
  calculateLapseStability,
  DEFAULT_WEIGHTS,
} from "../lib/fsrs-v4.ts";
import type { FsrsV4Input } from "../lib/types.ts";

const NOW = new Date("2026-03-09T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

// ── Retrievability ──────────────────────────────────────────

Deno.test("R(t) power-law: S=3, t=0 -> R=1.0", () => {
  assertAlmostEquals(calculateRetrievability(3, 0), 1.0, 0.001);
});

Deno.test("R(t) power-law: S=3, t=3 -> R=0.9", () => {
  assertAlmostEquals(calculateRetrievability(3, 3), 0.9, 0.001);
});

Deno.test("R(t) power-law: S=3, t=27 -> R=0.5", () => {
  assertAlmostEquals(calculateRetrievability(3, 27), 0.5, 0.001);
});

Deno.test("R(t) guard: S=0 -> R=0", () => {
  assertEquals(calculateRetrievability(0, 5), 0);
});

Deno.test("R(t) guard: S<0 -> R=0", () => {
  assertEquals(calculateRetrievability(-1, 5), 0);
});

// ── Initial Stability ───────────────────────────────────────

Deno.test("S_0: Again=1d, Hard=2d, Good=3d, Easy=6d", () => {
  const w = DEFAULT_WEIGHTS;
  assertEquals(calculateInitialStability(1, w), 1.0);
  assertEquals(calculateInitialStability(2, w), 2.0);
  assertEquals(calculateInitialStability(3, w), 3.0);
  assertEquals(calculateInitialStability(4, w), 6.0);
});

// ── New Card ────────────────────────────────────────────────

Deno.test("New card Good -> S=3, state=review, reps=1", () => {
  const out = computeFsrsV4Update({
    currentStability: 1, currentDifficulty: 5,
    currentReps: 0, currentLapses: 0, currentState: "new",
    lastReviewAt: null, grade: 3, isRecovering: false, now: NOW,
  });
  assertAlmostEquals(out.stability, 3.0, 0.01);
  assertEquals(out.state, "review");
  assertEquals(out.reps, 1);
  assertEquals(out.lapses, 0);
});

Deno.test("New card Again -> S=1, state=learning, lapses=1", () => {
  const out = computeFsrsV4Update({
    currentStability: 1, currentDifficulty: 5,
    currentReps: 0, currentLapses: 0, currentState: "new",
    lastReviewAt: null, grade: 1, isRecovering: false, now: NOW,
  });
  assertAlmostEquals(out.stability, 1.0, 0.01);
  assertEquals(out.state, "learning");
  assertEquals(out.lapses, 1);
});

// ── Recall Stability (spec table verification) ──────────────

Deno.test("Recall S=3d Good D=5 R~0.90 -> S'~6.7d (spec)", () => {
  const out = computeFsrsV4Update({
    currentStability: 3, currentDifficulty: 5,
    currentReps: 1, currentLapses: 0, currentState: "review",
    lastReviewAt: daysAgo(3), grade: 3, isRecovering: false, now: NOW,
  });
  assertAlmostEquals(out.stability, 6.7, 0.3);
});

Deno.test("Recall S=3d Hard -> S'~4.1d (spec)", () => {
  const out = computeFsrsV4Update({
    currentStability: 3, currentDifficulty: 5,
    currentReps: 1, currentLapses: 0, currentState: "review",
    lastReviewAt: daysAgo(3), grade: 2, isRecovering: false, now: NOW,
  });
  assertAlmostEquals(out.stability, 4.1, 0.3);
  assertEquals(out.state, "review"); // Hard = successful recall, NOT lapse
});

Deno.test("Recall S=3d Easy -> S'~12.6d (spec)", () => {
  const out = computeFsrsV4Update({
    currentStability: 3, currentDifficulty: 5,
    currentReps: 1, currentLapses: 0, currentState: "review",
    lastReviewAt: daysAgo(3), grade: 4, isRecovering: false, now: NOW,
  });
  assertAlmostEquals(out.stability, 12.6, 0.5);
});

// ── Lapse ───────────────────────────────────────────────────

Deno.test("Again reduces stability, state=relearning, lapses+1, reps=0", () => {
  const out = computeFsrsV4Update({
    currentStability: 10, currentDifficulty: 5,
    currentReps: 5, currentLapses: 0, currentState: "review",
    lastReviewAt: daysAgo(10), grade: 1, isRecovering: false, now: NOW,
  });
  assertEquals(out.stability < 10, true);
  assertEquals(out.stability >= 1, true);
  assertEquals(out.state, "relearning");
  assertEquals(out.lapses, 1);
  assertEquals(out.reps, 0);
});

// ── PLS e^(w14*(1-R)) term ──────────────────────────────────

Deno.test("PLS: lower R -> higher lapse stability", () => {
  const w = DEFAULT_WEIGHTS;
  const sf_high_r = calculateLapseStability(5, 10, 0.9, w);
  const sf_low_r = calculateLapseStability(5, 10, 0.3, w);
  assertEquals(sf_low_r > sf_high_r, true);
});

// ── Grade multiplier placement ──────────────────────────────

Deno.test("Hard NEVER decreases S (grade mult INSIDE +1)", () => {
  const out = computeFsrsV4Update({
    currentStability: 3, currentDifficulty: 5,
    currentReps: 1, currentLapses: 0, currentState: "review",
    lastReviewAt: daysAgo(3), grade: 2, isRecovering: false, now: NOW,
  });
  assertEquals(out.stability > 3, true,
    "Hard should INCREASE S. If S decreased, grade mult is OUTSIDE +1 (bug B4)");
});

// ── Recovery floor ──────────────────────────────────────────

Deno.test("Recovery: isRecovering gives minimum SInc=2.0x", () => {
  const out = computeFsrsV4Update({
    currentStability: 200, currentDifficulty: 5,
    currentReps: 20, currentLapses: 0, currentState: "review",
    lastReviewAt: daysAgo(200), grade: 3, isRecovering: true, now: NOW,
  });
  assertEquals(out.stability >= 400, true);
});

// ── W-params count ──────────────────────────────────────────

Deno.test("18 w-params (w0-w17), w8=1.10 (v4.2), w11=2.18 (PLS)", () => {
  const keys = Object.keys(DEFAULT_WEIGHTS);
  assertEquals(keys.length, 18);
  assertEquals(DEFAULT_WEIGHTS.w8, 1.10);
  assertEquals(DEFAULT_WEIGHTS.w11, 2.18);
});
