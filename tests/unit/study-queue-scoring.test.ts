/**
 * tests/unit/study-queue-scoring.test.ts — Unit tests for study queue scoring
 *
 * 23 tests covering:
 * - calculateNeedScore: overdue, mastery, fragility, novelty, priority multiplier
 * - calculateRetention: FSRS v4 power-law decay
 * - getMasteryColor: 5-color scale with domination threshold
 * - getMotivation: mastery-based motivation tier mapping
 * - Edge cases: null dates, zero stability, extreme priorities
 *
 * Run:
 *   cd /sessions/great-bold-mccarthy/mnt/petri/AXON\ PROJECTO/backend
 *   deno test tests/unit/study-queue-scoring.test.ts --allow-env --no-check
 */

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  NEED_CONFIG,
  calculateNeedScore,
  calculateRetention,
  getMasteryColor,
  getMotivation,
  MAX_FALLBACK_FLASHCARDS,
} from "../../supabase/functions/server/routes/study-queue/scoring.ts";

// ─── Test Suite: calculateNeedScore ─────────────────────────────

Deno.test("calculateNeedScore: null dueAt returns full overdue score (1.0)", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const score = calculateNeedScore(
    {
      dueAt: null,
      fsrsLapses: 0,
      fsrsReps: 0,
      fsrsState: "new",
      fsrsStability: 0,
      pKnow: 0.5,
      clinicalPriority: 0,
    },
    now
  );
  // overdue=1.0, mastery=0.5, fragility=0, novelty=1.0 (new state)
  // baseScore = 0.40*1 + 0.30*0.5 + 0.20*0 + 0.10*1 = 0.40 + 0.15 + 0.10 = 0.65
  // priorityMultiplier = 1.0 + 2^0 = 2.0
  // score = 0.65 * 2.0 = 1.30
  assertAlmostEquals(score, 1.30, 0.01);
});

Deno.test("calculateNeedScore: not overdue yet returns 0 overdue component", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const dueAt = new Date("2026-04-05T12:00:00Z"); // tomorrow
  const score = calculateNeedScore(
    {
      dueAt: dueAt.toISOString(),
      fsrsLapses: 0,
      fsrsReps: 10,
      fsrsState: "review",
      fsrsStability: 5,
      pKnow: 0.8,
      clinicalPriority: 0,
    },
    now
  );
  // overdue=0 (not due yet)
  // mastery = 1 - 0.8 = 0.2
  // fragility = 0 / 11 = 0
  // novelty = 0 (review state)
  // baseScore = 0.40*0 + 0.30*0.2 + 0.20*0 + 0.10*0 = 0.06
  // priorityMultiplier = 2.0
  // score = 0.06 * 2.0 = 0.12
  assertAlmostEquals(score, 0.12, 0.01);
});

Deno.test("calculateNeedScore: 1 day overdue with graceDays=1", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const dueAt = new Date("2026-04-03T12:00:00Z"); // 1 day ago
  const score = calculateNeedScore(
    {
      dueAt: dueAt.toISOString(),
      fsrsLapses: 0,
      fsrsReps: 5,
      fsrsState: "review",
      fsrsStability: 3,
      pKnow: 0.6,
      clinicalPriority: 0,
    },
    now
  );
  // daysOverdue = 1
  // overdue = 1 - exp(-1 / 1) = 1 - exp(-1) ≈ 1 - 0.368 ≈ 0.632
  const expectedOverdue = 1 - Math.exp(-1);
  const expectedMastery = 0.4;
  const expectedFragility = 0 / 6; // 0
  const expectedBase = 0.40 * expectedOverdue + 0.30 * expectedMastery;
  const expectedScore = expectedBase * 2.0;
  assertAlmostEquals(score, expectedScore, 0.01);
});

Deno.test("calculateNeedScore: multiple lapses increase fragility", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const score = calculateNeedScore(
    {
      dueAt: now.toISOString(),
      fsrsLapses: 3,
      fsrsReps: 7,
      fsrsState: "review",
      fsrsStability: 2,
      pKnow: 0.5,
      clinicalPriority: 0,
    },
    now
  );
  // fragility = min(1, 3 / (7 + 3 + 1)) = min(1, 3/11) ≈ 0.273
  const expectedFragility = 3 / 11;
  const expectedBase = 0.30 * 0.5 + 0.20 * expectedFragility; // no overdue, no novelty
  const expectedScore = expectedBase * 2.0;
  assertAlmostEquals(score, expectedScore, 0.01);
});

Deno.test("calculateNeedScore: new state adds novelty component", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const score1 = calculateNeedScore(
    {
      dueAt: now.toISOString(),
      fsrsLapses: 0,
      fsrsReps: 0,
      fsrsState: "new",
      fsrsStability: 0,
      pKnow: 0.5,
      clinicalPriority: 0,
    },
    now
  );
  const score2 = calculateNeedScore(
    {
      dueAt: now.toISOString(),
      fsrsLapses: 0,
      fsrsReps: 0,
      fsrsState: "review",
      fsrsStability: 0,
      pKnow: 0.5,
      clinicalPriority: 0,
    },
    now
  );
  // score1 should be higher due to novelty=1.0
  // difference = 0.10 * 1.0 * 2.0 = 0.20
  assertAlmostEquals(score1 - score2, 0.20, 0.01);
});

Deno.test("calculateNeedScore: exponential priority multiplier", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const base = {
    dueAt: now.toISOString(),
    fsrsLapses: 0,
    fsrsReps: 0,
    fsrsState: "review",
    fsrsStability: 0,
    pKnow: 0.5,
  };

  const score0 = calculateNeedScore({ ...base, clinicalPriority: 0 }, now);
  const score1 = calculateNeedScore({ ...base, clinicalPriority: 0.5 }, now);
  const score2 = calculateNeedScore({ ...base, clinicalPriority: 1.0 }, now);

  // priority multiplier = 1.0 + 2^(clinicalPriority * 2.0)
  // priority=0: 1.0 + 2^0 = 2.0
  // priority=0.5: 1.0 + 2^1 = 3.0  -> ratio 3/2 = 1.5
  // priority=1.0: 1.0 + 2^2 = 5.0  -> ratio 5/2 = 2.5
  assertAlmostEquals(score1 / score0, 1.5, 0.1);
  assertAlmostEquals(score2 / score0, 2.5, 0.1);
});

Deno.test("calculateNeedScore: p_know affects mastery component", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const base = {
    dueAt: now.toISOString(),
    fsrsLapses: 0,
    fsrsReps: 0,
    fsrsState: "review",
    fsrsStability: 0,
    clinicalPriority: 0,
  };

  const scoreHigh = calculateNeedScore({ ...base, pKnow: 0.9 }, now);
  const scoreLow = calculateNeedScore({ ...base, pKnow: 0.1 }, now);

  // high mastery (0.1 need) < low mastery (0.9 need)
  // scoreHigh = 0.30 * 0.1 * 2.0 = 0.06
  // scoreLow = 0.30 * 0.9 * 2.0 = 0.54
  assertAlmostEquals(scoreHigh, 0.06, 0.01);
  assertAlmostEquals(scoreLow, 0.54, 0.01);
});

Deno.test("calculateNeedScore: returns non-negative value", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const score = calculateNeedScore(
    {
      dueAt: now.toISOString(),
      fsrsLapses: 0,
      fsrsReps: 0,
      fsrsState: "review",
      fsrsStability: 0,
      pKnow: 0,
      clinicalPriority: -10, // negative priority
    },
    now
  );
  assertEquals(score >= 0, true);
});

// ─── Test Suite: calculateRetention ─────────────────────────────

Deno.test("calculateRetention: null lastReviewAt returns 0", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const retention = calculateRetention(null, 10, now);
  assertEquals(retention, 0);
});

Deno.test("calculateRetention: zero or negative stability returns 0", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const retention1 = calculateRetention(now.toISOString(), 0, now);
  const retention2 = calculateRetention(now.toISOString(), -5, now);
  assertEquals(retention1, 0);
  assertEquals(retention2, 0);
});

Deno.test("calculateRetention: just reviewed returns ~1.0", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  const retention = calculateRetention(now.toISOString(), 10, now);
  // daysSince = 0, R = (1 + 0 / 90)^-1 = 1
  assertEquals(retention, 1);
});

Deno.test("calculateRetention: 9 days with 1-day stability", () => {
  const lastReviewAt = new Date("2026-03-26T12:00:00Z");
  const now = new Date("2026-04-04T12:00:00Z"); // 9 days later
  const retention = calculateRetention(lastReviewAt.toISOString(), 1, now);
  // daysSince = 9, stabilityDays = 1
  // R = (1 + 9 / 9)^-1 = (2)^-1 = 0.5
  assertAlmostEquals(retention, 0.5, 0.01);
});

Deno.test("calculateRetention: 90 days with 10-day stability", () => {
  const lastReviewAt = new Date("2026-01-04T12:00:00Z");
  const now = new Date("2026-04-04T12:00:00Z"); // 90 days later
  const retention = calculateRetention(lastReviewAt.toISOString(), 10, now);
  // daysSince = 90, stabilityDays = 10
  // R = (1 + 90 / 90)^-1 = (2)^-1 = 0.5
  assertAlmostEquals(retention, 0.5, 0.01);
});

Deno.test("calculateRetention: clamped to [0, 1]", () => {
  const now = new Date("2026-04-04T12:00:00Z");
  // Very large stability in the past
  const retention1 = calculateRetention(now.toISOString(), 1000, now);
  const retention2 = calculateRetention(new Date("2026-01-01T12:00:00Z").toISOString(), 1, now);
  assertEquals(retention1 <= 1, true);
  assertEquals(retention2 >= 0, true);
});

// ─── Test Suite: getMasteryColor ────────────────────────────────

Deno.test("getMasteryColor: pKnow <= 0 returns gray", () => {
  const color = getMasteryColor(0, 1, 0);
  assertEquals(color, "gray");
});

Deno.test("getMasteryColor: blue when delta >= 1.10", () => {
  // pKnow=1, retention=1, priority=0
  // displayMastery = 1 * 1 = 1
  // threshold = 0.70 + 0 * 0.20 = 0.70
  // delta = 1 / 0.70 ≈ 1.43
  const color = getMasteryColor(1, 1, 0);
  assertEquals(color, "blue");
});

Deno.test("getMasteryColor: green when 1.00 <= delta < 1.10", () => {
  // pKnow=0.75, retention=1, priority=0
  // displayMastery = 0.75 * 1 = 0.75
  // threshold = 0.70
  // delta = 0.75 / 0.70 ≈ 1.07
  const color = getMasteryColor(0.75, 1, 0);
  assertEquals(color, "green");
});

Deno.test("getMasteryColor: yellow when 0.85 <= delta < 1.00", () => {
  // pKnow=0.59, retention=1, priority=0
  // displayMastery = 0.59
  // threshold = 0.70
  // delta = 0.59 / 0.70 ≈ 0.84
  // Wait, that's < 0.85, let's adjust
  // pKnow=0.60, retention=1, priority=0
  // delta = 0.60 / 0.70 ≈ 0.857
  const color = getMasteryColor(0.60, 1, 0);
  assertEquals(color, "yellow");
});

Deno.test("getMasteryColor: orange when 0.50 <= delta < 0.85", () => {
  // pKnow=0.40, retention=1, priority=0
  // threshold = 0.70
  // delta = 0.40 / 0.70 ≈ 0.571
  const color = getMasteryColor(0.40, 1, 0);
  assertEquals(color, "orange");
});

Deno.test("getMasteryColor: red when delta < 0.50", () => {
  // pKnow=0.25, retention=1, priority=0
  // delta = 0.25 / 0.70 ≈ 0.357
  const color = getMasteryColor(0.25, 1, 0);
  assertEquals(color, "red");
});

Deno.test("getMasteryColor: clinical priority raises threshold", () => {
  // With high priority, threshold increases, delta decreases
  // pKnow=0.8, retention=1, priority=1.0
  // displayMastery = 0.8
  // threshold = 0.70 + 1.0 * 0.20 = 0.90
  // delta = 0.8 / 0.90 ≈ 0.889
  const color = getMasteryColor(0.8, 1, 1);
  assertEquals(color, "yellow");
});

Deno.test("getMasteryColor: zero retention fallback", () => {
  // pKnow=0.5, retention=0, priority=0
  // displayMastery = 0.5 * 1.0 (fallback to 1.0) = 0.5
  // threshold = 0.70
  // delta = 0.5 / 0.70 ≈ 0.714
  const color = getMasteryColor(0.5, 0, 0);
  assertEquals(color, "orange");
});

// ─── Test Suite: getMotivation ──────────────────────────────────

Deno.test("getMotivation: pKnow < 0.30 returns low", () => {
  assertEquals(getMotivation(0.0), "low");
  assertEquals(getMotivation(0.29), "low");
});

Deno.test("getMotivation: 0.30 <= pKnow <= 0.70 returns medium", () => {
  assertEquals(getMotivation(0.30), "medium");
  assertEquals(getMotivation(0.50), "medium");
  assertEquals(getMotivation(0.70), "medium");
});

Deno.test("getMotivation: pKnow > 0.70 returns high", () => {
  assertEquals(getMotivation(0.71), "high");
  assertEquals(getMotivation(1.0), "high");
});

// ─── Test Suite: Constants ──────────────────────────────────────

Deno.test("NEED_CONFIG has correct weights", () => {
  assertEquals(NEED_CONFIG.overdueWeight, 0.40);
  assertEquals(NEED_CONFIG.masteryWeight, 0.30);
  assertEquals(NEED_CONFIG.fragilityWeight, 0.20);
  assertEquals(NEED_CONFIG.noveltyWeight, 0.10);
  assertEquals(NEED_CONFIG.graceDays, 1);
});

Deno.test("MAX_FALLBACK_FLASHCARDS is defined", () => {
  assertEquals(MAX_FALLBACK_FLASHCARDS, 10_000);
});
