/**
 * Tests for batch-review validators
 *
 * Tests cover:
 *   1. Constants
 *   2. mapToFsrsGrade: grade mapping (0-5 -> 1-4)
 *   3. validateReviewItem: valid items (grade + optional subtopic_id)
 *   4. validateReviewItem: error cases
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
// 3. validateReviewItem: valid items
// ═════════════════════════════════════════════════════════

Deno.test("validateReviewItem: valid minimal item", () => {
  const result = validateReviewItem({
    item_id: VALID_UUID,
    instrument_type: "flashcard",
    grade: 3,
  }, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid!.item_id, VALID_UUID);
  assertEquals(result.valid!.grade, 3);
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

// ═════════════════════════════════════════════════════════
// 4. validateReviewItem: error cases
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
