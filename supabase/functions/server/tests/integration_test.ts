// ============================================================
// tests/integration_test.ts — Cross-system verification
// Run: deno test --allow-none supabase/functions/server/tests/integration_test.ts
// ============================================================

import { assertEquals } from "https://deno.land/std@0.208.0/assert/assert_equals.ts";
import { computeFsrsV4Update } from "../lib/fsrs-v4.ts";
import { computeBktV4Update } from "../lib/bkt-v4.ts";
import { THRESHOLDS } from "../lib/types.ts";

const NOW = new Date("2026-03-09T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

Deno.test("isCorrect thresholds: FSRS Hard=recall, BKT Hard=incorrect", () => {
  // FSRS: Hard (grade=2) is successful recall
  const fsrs = computeFsrsV4Update({
    currentStability: 5, currentDifficulty: 5,
    currentReps: 3, currentLapses: 0, currentState: "review",
    lastReviewAt: daysAgo(5), grade: 2, isRecovering: false, now: NOW,
  });
  assertEquals(fsrs.stability > 5, true, "FSRS Hard should increase S");
  assertEquals(fsrs.state, "review");

  // BKT: Hard (grade=2) is incorrect -> mastery drops
  const bkt = computeBktV4Update({
    currentMastery: 0.5, maxReachedMastery: 0.5,
    isCorrect: false, instrumentType: "flashcard",
  });
  assertEquals(bkt.p_know < 0.5, true, "BKT Hard should decrease mastery");

  // Verify thresholds are correct
  assertEquals(THRESHOLDS.BKT_CORRECT_MIN_GRADE, 3);
  assertEquals(THRESHOLDS.EXAM_CORRECT_MIN_GRADE, 2);
  assertEquals(THRESHOLDS.FSRS_LAPSE_MAX_GRADE, 1);
});

Deno.test("PATH B simulation: grade-only request produces valid FSRS+BKT", () => {
  // Simulate what batch-review.ts PATH B would do:
  // 1. Read existing states (mock: new card)
  // 2. Compute FSRS
  // 3. Compute BKT
  // 4. Verify results are valid for DB upsert

  const grade = 3; // Good

  // Step 1: FSRS compute (new card defaults)
  const fsrs = computeFsrsV4Update({
    currentStability: 1, currentDifficulty: 5,
    currentReps: 0, currentLapses: 0, currentState: "new",
    lastReviewAt: null, grade: grade as 1|2|3|4,
    isRecovering: false, now: NOW,
  });

  // Step 2: BKT compute (first review defaults)
  const isCorrect = grade >= THRESHOLDS.BKT_CORRECT_MIN_GRADE;
  const bkt = computeBktV4Update({
    currentMastery: 0, maxReachedMastery: 0,
    isCorrect, instrumentType: "flashcard",
  });

  // Step 3: Verify all fields are valid for DB upsert
  assertEquals(fsrs.stability > 0, true);
  assertEquals(fsrs.difficulty >= 1 && fsrs.difficulty <= 10, true);
  assertEquals(typeof fsrs.due_at, "string");
  assertEquals(typeof fsrs.last_review_at, "string");
  assertEquals(fsrs.reps >= 0, true);
  assertEquals(fsrs.lapses >= 0, true);
  assertEquals(["new","learning","review","relearning"].includes(fsrs.state), true);

  assertEquals(bkt.p_know >= 0 && bkt.p_know <= 1, true);
  assertEquals(bkt.max_p_know >= 0 && bkt.max_p_know <= 1, true);
  assertEquals(typeof bkt.delta, "number");
  assertEquals(typeof bkt.is_recovering, "boolean");
});
