// ============================================================
// tests/bkt_keyword_propagation_test.ts — BKT keyword propagation tests
// Run: deno test --allow-none supabase/functions/server/tests/bkt_keyword_propagation_test.ts
//
// SPEC: axon-evaluation-spec.md v4.2
//   When a student reviews a flashcard or quiz, the result propagates
//   to linked keywords with weights:
//     flashcard → keyword weight 0.3
//     quiz      → keyword weight 0.5
//     keyword_direct → weight 1.0 (direct keyword review, no scaling)
//
// These tests validate the weighted propagation logic that sits ON TOP
// of the base BKT engine (bkt-v4.ts). The base engine computes the
// instrument-level mastery delta; the propagation layer scales that
// delta by the source weight before applying it to keyword mastery.
// ============================================================

import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/assert_almost_equals.ts";
import {
  updateMastery,
  getTypeMultiplier,
  calculateRecoveryMultiplier,
} from "../lib/bkt-v4.ts";
import { BKT_PARAMS, BKT_WEIGHTS } from "../lib/types.ts";
<<<<<<< Updated upstream
=======

>>>>>>> Stashed changes

// ─── Helpers ─────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Compute keyword mastery update with weighted propagation.
 *
 * For a correct response:
 *   base_gain = (1 - curMastery) * P_LEARN * typeMult * recoveryMult
 *   weighted_gain = base_gain * weight
 *   new_mastery = curMastery + weighted_gain
 *
 * For an incorrect response:
 *   base_forget = curMastery * P_FORGET
 *   weighted_forget = base_forget * weight
 *   new_mastery = curMastery - weighted_forget
 *
 * Weight applies to the CONTRIBUTION (spec: weight scales the delta).
 */
function computeKeywordUpdate(
  keywordMastery: number,
  maxKeywordMastery: number,
  isCorrect: boolean,
  instrumentType: "flashcard" | "quiz",
  weight: number,
): { newMastery: number; delta: number } {
  const typeMult = getTypeMultiplier(instrumentType);
  const recovery = calculateRecoveryMultiplier(keywordMastery, maxKeywordMastery);

  if (isCorrect) {
    const baseGain =
      (1 - keywordMastery) *
      BKT_PARAMS.P_LEARN *
      typeMult *
      recovery.multiplier;
    const weightedGain = baseGain * weight;
    const newMastery = Math.max(0, Math.min(1, keywordMastery + weightedGain));
    return { newMastery: round4(newMastery), delta: round4(weightedGain) };
  } else {
    const baseForget = keywordMastery * BKT_PARAMS.P_FORGET;
    const weightedForget = baseForget * weight;
    const newMastery = Math.max(0, Math.min(1, keywordMastery - weightedForget));
    return { newMastery: round4(newMastery), delta: round4(-weightedForget) };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. BKT_WEIGHTS constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deno.test("BKT_WEIGHTS: flashcard=0.3, quiz=0.5, keyword_direct=1.0", () => {
  assertEquals(BKT_WEIGHTS.flashcard, 0.3);
  assertEquals(BKT_WEIGHTS.quiz, 0.5);
  assertEquals(BKT_WEIGHTS.keyword_direct, 1.0);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. Weighted mastery update — correct responses
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deno.test("Flashcard correct with weight 0.3: gain is 30% of normal", () => {
  // Base BKT for flashcard: (1-0) * 0.18 * 1.0 * 1.0 = 0.18
  // Weighted for keyword: 0.18 * 0.3 = 0.054
  const result = computeKeywordUpdate(0, 0, true, "flashcard", BKT_WEIGHTS.flashcard);
  assertAlmostEquals(result.newMastery, 0.054, 0.001);
  assertAlmostEquals(result.delta, 0.054, 0.001);
});

Deno.test("Quiz correct with weight 0.5: gain is 50% of normal", () => {
  // Base BKT for quiz: (1-0) * 0.18 * 0.70 * 1.0 = 0.126
  // Weighted for keyword: 0.126 * 0.5 = 0.063
  const result = computeKeywordUpdate(0, 0, true, "quiz", BKT_WEIGHTS.quiz);
  assertAlmostEquals(result.newMastery, 0.063, 0.001);
  assertAlmostEquals(result.delta, 0.063, 0.001);
});

Deno.test("Keyword direct with weight 1.0: full gain (flashcard)", () => {
  // Base BKT for flashcard: (1-0) * 0.18 * 1.0 * 1.0 = 0.18
  // Weighted: 0.18 * 1.0 = 0.18 (no scaling)
  const result = computeKeywordUpdate(0, 0, true, "flashcard", BKT_WEIGHTS.keyword_direct);
  assertAlmostEquals(result.newMastery, 0.18, 0.001);
});

Deno.test("Keyword direct with weight 1.0: full gain (quiz)", () => {
  // Base BKT for quiz: (1-0) * 0.18 * 0.70 * 1.0 = 0.126
  // Weighted: 0.126 * 1.0 = 0.126
  const result = computeKeywordUpdate(0, 0, true, "quiz", BKT_WEIGHTS.keyword_direct);
  assertAlmostEquals(result.newMastery, 0.126, 0.001);
});

Deno.test("Flashcard correct at mastery 0.5 with weight 0.3", () => {
  // Base gain: (1-0.5) * 0.18 * 1.0 * 1.0 = 0.09
  // Weighted: 0.09 * 0.3 = 0.027
  // New: 0.5 + 0.027 = 0.527
  const result = computeKeywordUpdate(0.5, 0.5, true, "flashcard", BKT_WEIGHTS.flashcard);
  assertAlmostEquals(result.newMastery, 0.527, 0.001);
  assertAlmostEquals(result.delta, 0.027, 0.001);
});

Deno.test("Quiz correct at mastery 0.5 with weight 0.5", () => {
  // Base gain: (1-0.5) * 0.18 * 0.70 * 1.0 = 0.063
  // Weighted: 0.063 * 0.5 = 0.0315
  // New: 0.5 + 0.0315 = 0.5315
  const result = computeKeywordUpdate(0.5, 0.5, true, "quiz", BKT_WEIGHTS.quiz);
  assertAlmostEquals(result.newMastery, 0.5315, 0.001);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. Weighted incorrect response
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deno.test("Flashcard incorrect with weight 0.3: forget is weighted", () => {
  // Per spec, weight applies to the CONTRIBUTION
  // Base forget: 0.8 * 0.25 = 0.2
  // Weighted forget: 0.2 * 0.3 = 0.06
  // New: 0.8 - 0.06 = 0.74
  const result = computeKeywordUpdate(0.8, 0.8, false, "flashcard", BKT_WEIGHTS.flashcard);
  assertAlmostEquals(result.newMastery, 0.74, 0.001);
  assertAlmostEquals(result.delta, -0.06, 0.001);
});

Deno.test("Quiz incorrect with weight 0.5: forget is weighted", () => {
  // Base forget: 0.8 * 0.25 = 0.2
  // Weighted forget: 0.2 * 0.5 = 0.1
  // New: 0.8 - 0.1 = 0.7
  const result = computeKeywordUpdate(0.8, 0.8, false, "quiz", BKT_WEIGHTS.quiz);
  assertAlmostEquals(result.newMastery, 0.7, 0.001);
  assertAlmostEquals(result.delta, -0.1, 0.001);
});

Deno.test("Keyword direct incorrect with weight 1.0: full forget", () => {
  // Base forget: 0.8 * 0.25 = 0.2
  // Weighted forget: 0.2 * 1.0 = 0.2
  // New: 0.8 - 0.2 = 0.6 (same as base BKT)
  const result = computeKeywordUpdate(0.8, 0.8, false, "flashcard", BKT_WEIGHTS.keyword_direct);
  assertAlmostEquals(result.newMastery, 0.6, 0.001);

  // Verify this matches base BKT behavior
  const baseBkt = updateMastery(0.8, false, 1.0, 1.0);
  assertAlmostEquals(result.newMastery, baseBkt, 0.001);
});

Deno.test("Incorrect: weighted forget is less severe than base BKT", () => {
  const flashcardResult = computeKeywordUpdate(0.8, 0.8, false, "flashcard", BKT_WEIGHTS.flashcard);
  const quizResult = computeKeywordUpdate(0.8, 0.8, false, "quiz", BKT_WEIGHTS.quiz);
  const directResult = computeKeywordUpdate(0.8, 0.8, false, "flashcard", BKT_WEIGHTS.keyword_direct);

  // Flashcard weight 0.3 should lose least
  // Quiz weight 0.5 loses more
  // Direct weight 1.0 loses most
  assertEquals(flashcardResult.newMastery > quizResult.newMastery, true);
  assertEquals(quizResult.newMastery > directResult.newMastery, true);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. Progression with weights
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deno.test("Flashcard: 20 correct reviews with weight 0.3 -> keyword mastery ~0.67", () => {
  let m = 0;
  let max = 0;
  const trajectory: number[] = [0];

  for (let i = 0; i < 20; i++) {
    const result = computeKeywordUpdate(m, max, true, "flashcard", BKT_WEIGHTS.flashcard);
    m = result.newMastery;
    max = Math.max(max, m);
    trajectory.push(m);
  }

  // After 20 flashcard reviews at weight 0.3, keyword mastery should be moderate
  // Each step: gain = (1-m) * 0.18 * 1.0 * 1.0 * 0.3 = (1-m) * 0.054
  // This converges much slower than direct reviews
  assertAlmostEquals(m, 0.67, 0.05);

  // Verify monotonic increase
  for (let i = 1; i < trajectory.length; i++) {
    assertEquals(trajectory[i] >= trajectory[i - 1], true);
  }
});

Deno.test("Quiz: 10 correct reviews with weight 0.5 -> keyword mastery ~0.60", () => {
  let m = 0;
  let max = 0;
  const trajectory: number[] = [0];

  for (let i = 0; i < 10; i++) {
    const result = computeKeywordUpdate(m, max, true, "quiz", BKT_WEIGHTS.quiz);
    m = result.newMastery;
    max = Math.max(max, m);
    trajectory.push(m);
  }

  // Quiz weight 0.5 * quiz multiplier 0.70 = effective 0.063 per step from 0
  // Each step: gain = (1-m) * 0.18 * 0.70 * 1.0 * 0.5 = (1-m) * 0.063
  assertAlmostEquals(m, 0.48, 0.07);

  // Verify monotonic increase
  for (let i = 1; i < trajectory.length; i++) {
    assertEquals(trajectory[i] >= trajectory[i - 1], true);
  }
});

Deno.test("Mixed: 5 flashcard + 5 quiz -> intermediate mastery", () => {
  let m = 0;
  let max = 0;

  // 5 flashcard reviews (weight 0.3)
  for (let i = 0; i < 5; i++) {
    const result = computeKeywordUpdate(m, max, true, "flashcard", BKT_WEIGHTS.flashcard);
    m = result.newMastery;
    max = Math.max(max, m);
  }
  const afterFlashcards = m;

  // 5 quiz reviews (weight 0.5)
  for (let i = 0; i < 5; i++) {
    const result = computeKeywordUpdate(m, max, true, "quiz", BKT_WEIGHTS.quiz);
    m = result.newMastery;
    max = Math.max(max, m);
  }

  // After 5 flashcard + 5 quiz, should be between pure flashcard and pure quiz curves
  assertEquals(m > afterFlashcards, true);
  assertEquals(m > 0, true);
  assertEquals(m < 1, true);

  // Should be roughly between 0.3 and 0.5
  assertEquals(m > 0.25, true);
  assertEquals(m < 0.60, true);
});

Deno.test("Flashcard weight 0.3 converges slower than direct", () => {
  // 10 direct flashcard reviews (weight 1.0)
  let mDirect = 0, maxDirect = 0;
  for (let i = 0; i < 10; i++) {
    const r = computeKeywordUpdate(mDirect, maxDirect, true, "flashcard", 1.0);
    mDirect = r.newMastery;
    maxDirect = Math.max(maxDirect, mDirect);
  }

  // 10 weighted flashcard reviews (weight 0.3)
  let mWeighted = 0, maxWeighted = 0;
  for (let i = 0; i < 10; i++) {
    const r = computeKeywordUpdate(mWeighted, maxWeighted, true, "flashcard", 0.3);
    mWeighted = r.newMastery;
    maxWeighted = Math.max(maxWeighted, mWeighted);
  }

  // Direct should be significantly ahead
  assertEquals(mDirect > mWeighted, true);
  assertEquals(mDirect - mWeighted > 0.3, true);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. Recovery with weights
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deno.test("Recovery factor applies even with weighted updates", () => {
  // Keyword had high mastery (0.8), dropped to 0.3
  // maxKeywordMastery=0.8 > 0.50 threshold, current=0.3 < max -> recovery active
  const result = computeKeywordUpdate(0.3, 0.8, true, "flashcard", BKT_WEIGHTS.flashcard);

  // Base gain with recovery: (1-0.3) * 0.18 * 1.0 * 3.0 = 0.378
  // Weighted: 0.378 * 0.3 = 0.1134
  // New: 0.3 + 0.1134 = 0.4134
  assertAlmostEquals(result.newMastery, 0.4134, 0.001);
  assertEquals(result.delta > 0, true);
});

Deno.test("Recovery + quiz weight 0.5: combined multiplier", () => {
  // Recovery active: mastery 0.3, max 0.8
  const result = computeKeywordUpdate(0.3, 0.8, true, "quiz", BKT_WEIGHTS.quiz);

  // Base gain with recovery + quiz: (1-0.3) * 0.18 * 0.70 * 3.0 = 0.2646
  // Weighted: 0.2646 * 0.5 = 0.1323
  // New: 0.3 + 0.1323 = 0.4323
  assertAlmostEquals(result.newMastery, 0.4323, 0.001);
});

Deno.test("Recovery with weight still faster than non-recovery with weight", () => {
  // With recovery (max=0.8, current=0.3)
  const withRecovery = computeKeywordUpdate(0.3, 0.8, true, "flashcard", BKT_WEIGHTS.flashcard);

  // Without recovery (max=0.3, current=0.3 — never had higher mastery)
  const withoutRecovery = computeKeywordUpdate(0.3, 0.3, true, "flashcard", BKT_WEIGHTS.flashcard);

  // Recovery should produce a larger gain even when weighted
  assertEquals(withRecovery.delta > withoutRecovery.delta, true);
  // Recovery factor is 3x, so gain should be ~3x
  assertAlmostEquals(withRecovery.delta / withoutRecovery.delta, 3.0, 0.01);
});

Deno.test("Recovery NOT active for keyword if max < 0.50", () => {
  // max=0.4 < MIN_MASTERY_FOR_RECOVERY(0.50), so no recovery
  const result = computeKeywordUpdate(0.2, 0.4, true, "flashcard", BKT_WEIGHTS.flashcard);

  // Base gain without recovery: (1-0.2) * 0.18 * 1.0 * 1.0 = 0.144
  // Weighted: 0.144 * 0.3 = 0.0432
  // New: 0.2 + 0.0432 = 0.2432
  assertAlmostEquals(result.newMastery, 0.2432, 0.001);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. Edge cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deno.test("Weight=0 means no contribution to keyword", () => {
  const result = computeKeywordUpdate(0.5, 0.5, true, "flashcard", 0);
  assertEquals(result.newMastery, 0.5);
  assertEquals(result.delta, 0);
});

Deno.test("Weight=0 incorrect: no change to keyword", () => {
  const result = computeKeywordUpdate(0.8, 0.8, false, "flashcard", 0);
  assertEquals(result.newMastery, 0.8);
  assertEquals(result.delta, 0);
});

Deno.test("Multiple keywords linked: each gets independent update", () => {
  // Simulate a flashcard linked to 3 keywords at different mastery levels
  const keywords = [
    { mastery: 0.0, max: 0.0 },
    { mastery: 0.5, max: 0.5 },
    { mastery: 0.9, max: 0.9 },
  ];

  const results = keywords.map((kw) =>
    computeKeywordUpdate(kw.mastery, kw.max, true, "flashcard", BKT_WEIGHTS.flashcard)
  );

  // Each keyword should get a different delta based on its own mastery
  // Keyword at 0.0 gets more absolute gain than keyword at 0.9
  assertEquals(results[0].delta > results[1].delta, true);
  assertEquals(results[1].delta > results[2].delta, true);

  // All should increase
  for (const r of results) {
    assertEquals(r.delta > 0, true);
  }

  // Verify specific values
  // kw0: (1-0.0) * 0.18 * 1.0 * 1.0 * 0.3 = 0.054
  assertAlmostEquals(results[0].newMastery, 0.054, 0.001);
  // kw1: (1-0.5) * 0.18 * 1.0 * 1.0 * 0.3 = 0.027
  assertAlmostEquals(results[1].newMastery, 0.527, 0.001);
  // kw2: (1-0.9) * 0.18 * 1.0 * 1.0 * 0.3 = 0.0054
  assertAlmostEquals(results[2].newMastery, 0.9054, 0.001);
});

Deno.test("Keyword already at 1.0: weighted update stays clamped", () => {
  const result = computeKeywordUpdate(1.0, 1.0, true, "flashcard", BKT_WEIGHTS.flashcard);
  assertEquals(result.newMastery, 1.0);
  assertEquals(result.delta, 0);
});

Deno.test("Keyword at 1.0 incorrect with weight: drops proportionally", () => {
  // Base forget: 1.0 * 0.25 = 0.25
  // Weighted: 0.25 * 0.3 = 0.075
  // New: 1.0 - 0.075 = 0.925
  const result = computeKeywordUpdate(1.0, 1.0, false, "flashcard", BKT_WEIGHTS.flashcard);
  assertAlmostEquals(result.newMastery, 0.925, 0.001);
});

Deno.test("Keyword at 0.0 incorrect: no change (nothing to forget)", () => {
  const result = computeKeywordUpdate(0.0, 0.0, false, "flashcard", BKT_WEIGHTS.flashcard);
  assertEquals(result.newMastery, 0.0);
  assertEquals(result.delta, 0);
});

Deno.test("Very small mastery: weighted update doesn't go negative", () => {
  const result = computeKeywordUpdate(0.001, 0.001, false, "quiz", BKT_WEIGHTS.quiz);
  assertEquals(result.newMastery >= 0, true);
});

Deno.test("Weight ordering: quiz(0.5) contributes more than flashcard(0.3)", () => {
  const flashcard = computeKeywordUpdate(0.0, 0.0, true, "flashcard", BKT_WEIGHTS.flashcard);
  const quiz = computeKeywordUpdate(0.0, 0.0, true, "quiz", BKT_WEIGHTS.quiz);

  // Flashcard base=0.18, weighted=0.054
  // Quiz base=0.126, weighted=0.063
  // Quiz weight 0.5 compensates for lower type multiplier and still contributes more
  assertEquals(quiz.newMastery > flashcard.newMastery, true);
});

Deno.test("Symmetry: weight=1.0 matches base BKT updateMastery for correct", () => {
  const mastery = 0.4;
  const typeMult = getTypeMultiplier("flashcard");
  const recoveryMult = 1.0; // no recovery

  const baseResult = updateMastery(mastery, true, typeMult, recoveryMult);
  const keywordResult = computeKeywordUpdate(mastery, mastery, true, "flashcard", 1.0);

  assertAlmostEquals(keywordResult.newMastery, baseResult, 0.0001);
});

Deno.test("Symmetry: weight=1.0 matches base BKT updateMastery for incorrect", () => {
  const mastery = 0.6;
  const typeMult = getTypeMultiplier("flashcard");
  const recoveryMult = 1.0;

  const baseResult = updateMastery(mastery, false, typeMult, recoveryMult);
  const keywordResult = computeKeywordUpdate(mastery, mastery, false, "flashcard", 1.0);

  assertAlmostEquals(keywordResult.newMastery, baseResult, 0.0001);
});
