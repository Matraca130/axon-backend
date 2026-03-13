/**
 * Tests for study-queue scoring algorithms
 *
 * Tests cover:
 *   1. calculateNeedScore: overdue, mastery, fragility, novelty, priority
 *   2. calculateRetention: FSRS v4 power-law retention curve
 *   3. getMasteryColor: 5-color scale with domination threshold
 *
 * Run: deno test supabase/functions/server/tests/scoring_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertAlmostEquals,
} from "https://deno.land/std@0.224.0/assert/assert_almost_equals.ts";

import {
  calculateNeedScore,
  calculateRetention,
  getMasteryColor,
  NEED_CONFIG,
} from "../routes/study-queue/scoring.ts";

// ═════════════════════════════════════════════════════════
// 1. NEED_CONFIG constants
// ═════════════════════════════════════════════════════════

Deno.test("NEED_CONFIG: weights sum to 1.0", () => {
  const sum =
    NEED_CONFIG.overdueWeight +
    NEED_CONFIG.masteryWeight +
    NEED_CONFIG.fragilityWeight +
    NEED_CONFIG.noveltyWeight;
  assertAlmostEquals(sum, 1.0, 0.001);
});

Deno.test("NEED_CONFIG: overdue is heaviest weight (0.40)", () => {
  assertEquals(NEED_CONFIG.overdueWeight, 0.40);
});

// ═════════════════════════════════════════════════════════
// 2. calculateNeedScore
// ═════════════════════════════════════════════════════════

const NOW = new Date("2026-03-13T12:00:00Z");

Deno.test("calculateNeedScore: new card (no dueAt) gets max overdue", () => {
  const score = calculateNeedScore({
    dueAt: null,
    fsrsLapses: 0,
    fsrsReps: 0,
    fsrsState: "new",
    fsrsStability: 1,
    pKnow: 0,
    clinicalPriority: 0,
  }, NOW);
  // overdue=1.0, needMastery=1.0, fragility=0, novelty=1.0
  // base = 0.40*1.0 + 0.30*1.0 + 0.20*0 + 0.10*1.0 = 0.80
  // priorityMultiplier = 1 + 2^0 = 2.0
  // score = 0.80 * 2.0 = 1.60
  assertAlmostEquals(score, 1.60, 0.01);
});

Deno.test("calculateNeedScore: not overdue = zero overdue component", () => {
  const futureDate = new Date(NOW.getTime() + 86400000).toISOString(); // 1 day future
  const score = calculateNeedScore({
    dueAt: futureDate,
    fsrsLapses: 0,
    fsrsReps: 5,
    fsrsState: "review",
    fsrsStability: 10,
    pKnow: 0.8,
    clinicalPriority: 0,
  }, NOW);
  // overdue=0 (future), needMastery=0.2, fragility=0/(5+0+1)=0, novelty=0
  // base = 0.30*0.2 = 0.06
  // score = 0.06 * 2.0 = 0.12
  assertAlmostEquals(score, 0.12, 0.01);
});

Deno.test("calculateNeedScore: high clinical priority amplifies score", () => {
  const base = {
    dueAt: null,
    fsrsLapses: 0,
    fsrsReps: 0,
    fsrsState: "new" as const,
    fsrsStability: 1,
    pKnow: 0,
  };
  const lowPriority = calculateNeedScore({ ...base, clinicalPriority: 0 }, NOW);
  const highPriority = calculateNeedScore({ ...base, clinicalPriority: 1 }, NOW);
  // clinicalPriority=1 -> multiplier = 1 + 2^2 = 5.0 vs 2.0
  assertEquals(highPriority > lowPriority, true);
  assertAlmostEquals(highPriority / lowPriority, 2.5, 0.01);
});

Deno.test("calculateNeedScore: high lapses increase fragility", () => {
  const lowLapses = calculateNeedScore({
    dueAt: NOW.toISOString(),
    fsrsLapses: 0, fsrsReps: 10, fsrsState: "review",
    fsrsStability: 5, pKnow: 0.5, clinicalPriority: 0,
  }, NOW);
  const highLapses = calculateNeedScore({
    dueAt: NOW.toISOString(),
    fsrsLapses: 5, fsrsReps: 10, fsrsState: "review",
    fsrsStability: 5, pKnow: 0.5, clinicalPriority: 0,
  }, NOW);
  assertEquals(highLapses > lowLapses, true);
});

Deno.test("calculateNeedScore: result is always >= 0", () => {
  const score = calculateNeedScore({
    dueAt: new Date(NOW.getTime() + 999999999).toISOString(),
    fsrsLapses: 0, fsrsReps: 100, fsrsState: "review",
    fsrsStability: 100, pKnow: 1.0, clinicalPriority: 0,
  }, NOW);
  assertEquals(score >= 0, true);
});

// ═════════════════════════════════════════════════════════
// 3. calculateRetention
// ═════════════════════════════════════════════════════════

Deno.test("calculateRetention: null lastReviewAt returns 0", () => {
  assertEquals(calculateRetention(null, 10, NOW), 0);
});

Deno.test("calculateRetention: zero stability returns 0", () => {
  assertEquals(calculateRetention(NOW.toISOString(), 0, NOW), 0);
});

Deno.test("calculateRetention: just reviewed = near 1.0", () => {
  const r = calculateRetention(NOW.toISOString(), 10, NOW);
  assertAlmostEquals(r, 1.0, 0.01);
});

Deno.test("calculateRetention: long time ago = low retention", () => {
  const longAgo = new Date(NOW.getTime() - 90 * 86400000).toISOString(); // 90 days ago
  const r = calculateRetention(longAgo, 1, NOW);
  assertEquals(r < 0.2, true);
});

Deno.test("calculateRetention: higher stability = slower decay", () => {
  const weekAgo = new Date(NOW.getTime() - 7 * 86400000).toISOString();
  const lowStability = calculateRetention(weekAgo, 1, NOW);
  const highStability = calculateRetention(weekAgo, 30, NOW);
  assertEquals(highStability > lowStability, true);
});

Deno.test("calculateRetention: result clamped to [0, 1]", () => {
  const r = calculateRetention(NOW.toISOString(), 0.001, NOW);
  assertEquals(r >= 0 && r <= 1, true);
});

// ═════════════════════════════════════════════════════════
// 4. getMasteryColor
// ═════════════════════════════════════════════════════════

Deno.test("getMasteryColor: zero pKnow = gray", () => {
  assertEquals(getMasteryColor(0, 0, 0), "gray");
});

Deno.test("getMasteryColor: very low mastery = red", () => {
  assertEquals(getMasteryColor(0.1, 0.5, 0), "red");
});

Deno.test("getMasteryColor: moderate mastery = yellow/orange", () => {
  const color = getMasteryColor(0.6, 1.0, 0);
  // delta = 0.6 / 0.70 = 0.857 -> >= 0.85 -> yellow
  assertEquals(color, "yellow");
});

Deno.test("getMasteryColor: high mastery with retention = green/blue", () => {
  // pKnow=0.9, retention=1.0, priority=0
  // displayMastery = 0.9 * 1.0 = 0.9
  // threshold = 0.70
  // delta = 0.9/0.70 = 1.286 -> >= 1.10 -> blue
  assertEquals(getMasteryColor(0.9, 1.0, 0), "blue");
});

Deno.test("getMasteryColor: high priority raises threshold", () => {
  // Same mastery, but higher priority means harder to be 'green'
  // pKnow=0.7, retention=1.0, priority=0: threshold=0.70, delta=1.0 -> green
  assertEquals(getMasteryColor(0.7, 1.0, 0), "green");
  // pKnow=0.7, retention=1.0, priority=1: threshold=0.90, delta=0.778 -> orange
  assertEquals(getMasteryColor(0.7, 1.0, 1), "orange");
});

Deno.test("getMasteryColor: low retention degrades display mastery", () => {
  // pKnow=0.9 but retention=0.5 -> displayMastery=0.45
  // threshold=0.70, delta=0.45/0.70=0.643 -> >= 0.50 -> orange
  assertEquals(getMasteryColor(0.9, 0.5, 0), "orange");
});
