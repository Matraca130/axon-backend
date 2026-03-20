/**
 * Tests for batch-review validators
 *
 * Tests cover:
 *   1. mapToFsrsGrade: grade mapping (0-5 -> 1-4)
 *   2. validateReviewItem: PATH A validation (with fsrs_update/bkt_update)
 *   3. validateReviewItem: PATH B validation (minimal, grade only)
 *   4. validateReviewItem: error cases
 *   5. Constants
 *
 * Run: deno test supabase/functions/server/tests/batch_review_validators_test.ts
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  mapToFsrsGrade,
  validateReviewItem,
  MAX_BATCH_SIZE,
  DEFAULT_LEECH_THRESHOLD,
  FSRS_STATES,
} from "../routes/study/batch-review-validators.ts";

const VALID_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const VALID_UUID_2 = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";

// ═════════════════════════════════════════════════════════
// 1. Constants
// ═════════════════════════════════════════════════════════

Deno.test("Constants: MAX_BATCH_SIZE = 100", () => {
  assertEquals(MAX_BATCH_SIZE, 100);
});

Deno.test("Constants: DEFAULT_LEECH_THRESHOLD = 8", () => {
  assertEquals(DEFAULT_LEECH_THRESHOLD, 8);
});

Deno.test("Constants: FSRS_STATES has 4 valid states", () => {
  assertEquals(FSRS_STATES.length, 4);
  assertEquals([...FSRS_STATES].sort(), ["learning", "new", "relearning", "review"]);
});

// ═════════════════════════════════════════════════════════
// 2. mapToFsrsGrade
// ═════════════════════════════════════════════════════════

Deno.test("mapToFsrsGrade: 0 -> 1 (Again)", () => {
  assertEquals(mapToFsrsGrade(0), 1);
});

Deno.test("mapToFsrsGrade: 1 -> 1 (Again)", () => {
  assertEquals(mapToFsrsGrade(1), 1);
});

Deno.test("mapToFsrsGrade: 2 -> 2 (Hard)", () => {
  assertEquals(mapToFsrsGrade(2), 2);
});

Deno.test("mapToFsrsGrade: 3 -> 3 (Good)", () => {
  assertEquals(mapToFsrsGrade(3), 3);
});

Deno.test("mapToFsrsGrade: 4 -> 4 (Easy)", () => {
  assertEquals(mapToFsrsGrade(4), 4);
});

Deno.test("mapToFsrsGrade: 5 -> 4 (legacy SM-2 grade 5 maps to Easy)", () => {
  assertEquals(mapToFsrsGrade(5), 4);
});

// ═════════════════════════════════════════════════════════
// 3. validateReviewItem: valid PATH B (minimal)
// ═════════════════════════════════════════════════════════

Deno.test("validateReviewItem: valid minimal PATH B item", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "flashcard",
    grade: 3,
  }, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid!.item_id, VALID_UUID);
  assertEquals(result.valid!.grade, 3);
  assertEquals(result.valid!.fsrs_update, undefined);
  assertEquals(result.valid!.bkt_update, undefined);
});

Deno.test("validateReviewItem: with optional subtopic_id", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "flashcard",
    grade: 4,
    subtopic_id: VALID_UUID_2,
  }, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid!.subtopic_id, VALID_UUID_2);
});

Deno.test("validateReviewItem: with optional response_time_ms", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "quiz",
    grade: 2,
    response_time_ms: 5000,
  }, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid!.response_time_ms, 5000);
});

Deno.test("validateReviewItem: valid PATH A with full bkt_update", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "quiz",
    grade: 4,
    bkt_update: {
      subtopic_id: VALID_UUID_2,
      p_know: 0.75,
      p_transit: 0.18,
      p_slip: 0.10,
      p_guess: 0.25,
      delta: 0.05,
      total_attempts: 10,
      correct_attempts: 7,
      last_attempt_at: "2026-03-13T12:00:00Z",
    },
  }, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid!.bkt_update!.subtopic_id, VALID_UUID_2);
  assertEquals(result.valid!.bkt_update!.p_know, 0.75);
  assertEquals(result.valid!.bkt_update!.p_transit, 0.18);
  assertEquals(result.valid!.bkt_update!.p_slip, 0.10);
  assertEquals(result.valid!.bkt_update!.p_guess, 0.25);
  assertEquals(result.valid!.bkt_update!.delta, 0.05);
  assertEquals(result.valid!.bkt_update!.total_attempts, 10);
  assertEquals(result.valid!.bkt_update!.correct_attempts, 7);
  assertEquals(result.valid!.bkt_update!.last_attempt_at, "2026-03-13T12:00:00Z");
});

// ═════════════════════════════════════════════════════════
// 4. validateReviewItem: valid PATH A (with fsrs_update)
// ═════════════════════════════════════════════════════════

Deno.test("validateReviewItem: valid PATH A with fsrs_update", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "flashcard",
    grade: 3,
    fsrs_update: {
      stability: 5.0,
      difficulty: 4.5,
      due_at: "2026-03-14T12:00:00Z",
      last_review_at: "2026-03-13T12:00:00Z",
      reps: 3,
      lapses: 1,
      state: "review",
    },
  }, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid!.fsrs_update!.stability, 5.0);
  assertEquals(result.valid!.fsrs_update!.state, "review");
});

// ═════════════════════════════════════════════════════════
// 5. validateReviewItem: error cases
// ═════════════════════════════════════════════════════════

Deno.test("validateReviewItem: missing item_id", () => {
  const result = validateReviewItem({
    instrument_type: "flashcard",
    grade: 3,
  }, 0);
  assertEquals(result.valid, null);
  assertEquals(result.error!.includes("item_id"), true);
});

Deno.test("validateReviewItem: invalid item_id (not UUID)", () => {
  const result = validateReviewItem({
    item_id: "not-a-uuid",
    instrument_type: "flashcard",
    grade: 3,
  }, 0);
  assertEquals(result.valid, null);
  assertEquals(result.error!.includes("item_id"), true);
});

Deno.test("validateReviewItem: missing instrument_type", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    grade: 3,
  }, 0);
  assertEquals(result.valid, null);
  assertEquals(result.error!.includes("instrument_type"), true);
});

Deno.test("validateReviewItem: grade out of range", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "flashcard",
    grade: 6,
  }, 0);
  assertEquals(result.valid, null);
  assertEquals(result.error!.includes("grade"), true);
});

Deno.test("validateReviewItem: negative grade", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "flashcard",
    grade: -1,
  }, 0);
  assertEquals(result.valid, null);
  assertEquals(result.error!.includes("grade"), true);
});

Deno.test("validateReviewItem: invalid subtopic_id", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "flashcard",
    grade: 3,
    subtopic_id: "bad-uuid",
  }, 0);
  assertEquals(result.valid, null);
  assertEquals(result.error!.includes("subtopic_id"), true);
});

Deno.test("validateReviewItem: invalid fsrs_update.state", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "flashcard",
    grade: 3,
    fsrs_update: {
      stability: 5.0,
      difficulty: 4.5,
      due_at: "2026-03-14T12:00:00Z",
      last_review_at: "2026-03-13T12:00:00Z",
      reps: 3,
      lapses: 1,
      state: "invalid_state",
    },
  }, 0);
  assertEquals(result.valid, null);
  assertEquals(result.error!.includes("state"), true);
});

Deno.test("validateReviewItem: error prefix includes index", () => {
  const result = validateReviewItem({
    instrument_type: "flashcard",
    grade: 3,
  }, 7);
  assertEquals(result.error!.includes("reviews[7]"), true);
});

Deno.test("validateReviewItem: negative response_time_ms rejected", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "flashcard",
    grade: 3,
    response_time_ms: -100,
  }, 0);
  assertEquals(result.valid, null);
  assertEquals(result.error!.includes("response_time_ms"), true);
});
