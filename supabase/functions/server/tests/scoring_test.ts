/**
 * Tests for study-queue scoring pure functions
 *
 * Tests cover:
 *   1. calculateNeedScore: overdue, mastery, fragility, novelty, clinical priority
 *   2. calculateRetention: FSRS v4 power-law retention decay
 *   3. getMasteryColor: 5-color scale with domination threshold
 *
 * Run: deno test supabase/functions/server/tests/scoring_test.ts
 */

import {
  assertEquals,
  assertAlmostEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  calculateNeedScore,
  calculateRetention,
  getMasteryColor,
  NEED_CONFIG,
  type NeedScoreInput,
} from "../routes/study-queue/scoring.ts";

// ═══════════════════════════════════════════════════════════════
// 1. calculateNeedScore
// ═══════════════════════════════════════════════════════════════

const BASE_INPUT: NeedScoreInput = {
  dueAt: null,
  fsrsLapses: 0,
  fsrsReps: 0,
  fsrsState: "new",
  fsrsStability: 1,
  pKnow: 0,
  clinicalPriority: 0,
};

const NOW = new Date("2025-06-15T12:00:00Z");

Deno.test("calculateNeedScore: new concept with no due date scores maximum base", () => {
  // overdue=1, needMastery=1, fragility=0, novelty=1 (new state)
  // base = 0.40*1 + 0.30*1 + 0.20*0 + 0.10*1 = 0.80
  // multiplier = 1 + 2^(0*2) = 1 + 1 = 2
  // score = 0.80 * 2 = 1.60
  const score = calculateNeedScore(BASE_INPUT, NOW);
  assertAlmostEquals(score, 1.6, 0.01);
});

Deno.test("calculateNeedScore: high mastery reduces score", () => {
  const input: NeedScoreInput = {
    ...BASE_INPUT,
    dueAt: new Date(NOW.getTime() + 86400000).toISOString(), // due tomorrow (not overdue)
    fsrsState: "review",
    pKnow: 0.95,
  };
  const score = calculateNeedScore(input, NOW);
  // overdue=0, needMastery=0.05, fragility=0, novelty=0
  // base = 0.30*0.05 = 0.015
  // Should be low
  assertEquals(score < 0.1, true);
});

Deno.test("calculateNeedScore: overdue items get higher scores", () => {
  const notOverdue: NeedScoreInput = {
    ...BASE_INPUT,
    dueAt: new Date(NOW.getTime() + 86400000).toISOString(), // due tomorrow
    fsrsState: "review",
    pKnow: 0.5,
  };
  const overdue: NeedScoreInput = {
    ...BASE_INPUT,
    dueAt: new Date(NOW.getTime() - 3 * 86400000).toISOString(), // 3 days overdue
    fsrsState: "review",
    pKnow: 0.5,
  };
  const scoreNotOverdue = calculateNeedScore(notOverdue, NOW);
  const scoreOverdue = calculateNeedScore(overdue, NOW);
  assertEquals(scoreOverdue > scoreNotOverdue, true);
});

Deno.test("calculateNeedScore: clinical priority exponentially scales score", () => {
  const lowPriority = calculateNeedScore({ ...BASE_INPUT, clinicalPriority: 0 }, NOW);
  const highPriority = calculateNeedScore({ ...BASE_INPUT, clinicalPriority: 1 }, NOW);
  // priority=0 → multiplier = 1+2^0 = 2
  // priority=1 → multiplier = 1+2^2 = 5
  assertEquals(highPriority > lowPriority, true);
  assertAlmostEquals(highPriority / lowPriority, 5 / 2, 0.01);
});

Deno.test("calculateNeedScore: fragility increases with lapses", () => {
  const noLapses = calculateNeedScore({ ...BASE_INPUT, fsrsLapses: 0, fsrsReps: 10, fsrsState: "review" }, NOW);
  const manyLapses = calculateNeedScore({ ...BASE_INPUT, fsrsLapses: 5, fsrsReps: 10, fsrsState: "review" }, NOW);
  assertEquals(manyLapses > noLapses, true);
});

Deno.test("calculateNeedScore: result is never negative", () => {
  const score = calculateNeedScore({
    ...BASE_INPUT,
    dueAt: new Date(NOW.getTime() + 365 * 86400000).toISOString(), // far future
    pKnow: 1.0,
    fsrsState: "review",
  }, NOW);
  assertEquals(score >= 0, true);
});

// ═══════════════════════════════════════════════════════════════
// 2. calculateRetention
// ═══════════════════════════════════════════════════════════════

Deno.test("calculateRetention: no review returns 0", () => {
  assertEquals(calculateRetention(null, 10, NOW), 0);
});

Deno.test("calculateRetention: zero stability returns 0", () => {
  assertEquals(calculateRetention("2025-06-14T12:00:00Z", 0, NOW), 0);
});

Deno.test("calculateRetention: just reviewed returns ~1", () => {
  const ret = calculateRetention(NOW.toISOString(), 10, NOW);
  assertAlmostEquals(ret, 1.0, 0.01);
});

Deno.test("calculateRetention: decays over time", () => {
  const recent = calculateRetention("2025-06-14T12:00:00Z", 10, NOW); // 1 day ago
  const old = calculateRetention("2025-06-01T12:00:00Z", 10, NOW);   // 14 days ago
  assertEquals(recent > old, true);
  assertEquals(recent <= 1.0, true);
  assertEquals(old >= 0.0, true);
});

Deno.test("calculateRetention: higher stability decays slower", () => {
  const lastReview = "2025-06-08T12:00:00Z"; // 7 days ago
  const lowStability = calculateRetention(lastReview, 2, NOW);
  const highStability = calculateRetention(lastReview, 30, NOW);
  assertEquals(highStability > lowStability, true);
});

Deno.test("calculateRetention: clamped between 0 and 1", () => {
  const ret = calculateRetention("2020-01-01T00:00:00Z", 1, NOW);
  assertEquals(ret >= 0, true);
  assertEquals(ret <= 1, true);
});

// ═══════════════════════════════════════════════════════════════
// 3. getMasteryColor
// ═══════════════════════════════════════════════════════════════

Deno.test("getMasteryColor: zero pKnow returns gray", () => {
  assertEquals(getMasteryColor(0, 0.5, 0), "gray");
});

Deno.test("getMasteryColor: very low mastery returns red", () => {
  assertEquals(getMasteryColor(0.1, 1.0, 0), "red");
});

Deno.test("getMasteryColor: moderate mastery returns orange", () => {
  // threshold = 0.70, displayMastery = 0.40*1 = 0.40, delta = 0.40/0.70 ~ 0.57
  assertEquals(getMasteryColor(0.40, 1.0, 0), "orange");
});

Deno.test("getMasteryColor: medium mastery returns yellow", () => {
  // threshold = 0.70, displayMastery = 0.62*1 = 0.62, delta = 0.62/0.70 ~ 0.886
  assertEquals(getMasteryColor(0.62, 1.0, 0), "yellow");
});

Deno.test("getMasteryColor: at domination threshold returns green", () => {
  // threshold = 0.70, displayMastery = 0.70, delta = 1.0
  assertEquals(getMasteryColor(0.70, 1.0, 0), "green");
});

Deno.test("getMasteryColor: well above threshold returns blue", () => {
  // threshold = 0.70, displayMastery = 0.90, delta = 0.90/0.70 ~ 1.286
  assertEquals(getMasteryColor(0.90, 1.0, 0), "blue");
});

Deno.test("getMasteryColor: clinical priority raises domination threshold", () => {
  // Without priority: threshold=0.70, 0.75/0.70 = 1.07 → green
  assertEquals(getMasteryColor(0.75, 1.0, 0), "green");
  // With priority=1: threshold=0.90, 0.75/0.90 = 0.833 → orange (below 0.85 yellow cutoff)
  assertEquals(getMasteryColor(0.75, 1.0, 1), "orange");
  // With priority=1: threshold=0.90, 0.80/0.90 = 0.889 → yellow (above 0.85)
  assertEquals(getMasteryColor(0.80, 1.0, 1), "yellow");
});

Deno.test("getMasteryColor: low retention reduces display mastery", () => {
  // High pKnow but low retention
  // displayMastery = 0.90 * 0.3 = 0.27, threshold = 0.70, delta = 0.27/0.70 ~ 0.386
  assertEquals(getMasteryColor(0.90, 0.3, 0), "red");
});

Deno.test("getMasteryColor: zero retention with pKnow uses fallback retention=1", () => {
  // retention=0, pKnow > 0 → fallback retention = 1.0
  // displayMastery = 0.80 * 1.0 = 0.80, threshold = 0.70, delta = 0.80/0.70 ~ 1.143
  assertEquals(getMasteryColor(0.80, 0, 0), "blue");
});

// ═══════════════════════════════════════════════════════════════
// 4. NEED_CONFIG sanity checks
// ═══════════════════════════════════════════════════════════════

Deno.test("NEED_CONFIG: weights sum to 1.0", () => {
  const sum = NEED_CONFIG.overdueWeight +
    NEED_CONFIG.masteryWeight +
    NEED_CONFIG.fragilityWeight +
    NEED_CONFIG.noveltyWeight;
  assertAlmostEquals(sum, 1.0, 0.001);
});

Deno.test("NEED_CONFIG: graceDays is positive", () => {
  assertEquals(NEED_CONFIG.graceDays > 0, true);
});
