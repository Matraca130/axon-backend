/**
 * tests/unit/batch-review-validators.test.ts — Unit tests for batch review validation
 *
 * 21 tests covering:
 * - mapToFsrsGrade: 0-5 to FSRS 1-4 grade mapping
 * - validateReviewItem: item validation with UUID, grade range, optional fields
 * - Constants: MAX_BATCH_SIZE, FSRS_STATES, DEFAULT_LEECH_THRESHOLD
 * - Edge cases: invalid UUIDs, out-of-range grades, missing fields
 *
 * Run:
 *   cd /sessions/great-bold-mccarthy/mnt/petri/AXON\ PROJECTO/backend
 *   deno test tests/unit/batch-review-validators.test.ts --allow-env --no-check
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MAX_BATCH_SIZE,
  FSRS_STATES,
  DEFAULT_LEECH_THRESHOLD,
  mapToFsrsGrade,
  validateReviewItem,
} from "../../supabase/functions/server/routes/study/batch-review-validators.ts";

// ─── Test Suite: mapToFsrsGrade ──────────────────────────────────

Deno.test("mapToFsrsGrade: grade 0 maps to 1 (Again)", () => {
  assertEquals(mapToFsrsGrade(0), 1);
});

Deno.test("mapToFsrsGrade: grade 1 maps to 1 (Again)", () => {
  assertEquals(mapToFsrsGrade(1), 1);
});

Deno.test("mapToFsrsGrade: grade 2 maps to 2 (Hard)", () => {
  assertEquals(mapToFsrsGrade(2), 2);
});

Deno.test("mapToFsrsGrade: grade 3 maps to 3 (Good)", () => {
  assertEquals(mapToFsrsGrade(3), 3);
});

Deno.test("mapToFsrsGrade: grade 4 maps to 4 (Easy)", () => {
  assertEquals(mapToFsrsGrade(4), 4);
});

Deno.test("mapToFsrsGrade: grade 5 maps to 4 (Easy, legacy SM-2)", () => {
  assertEquals(mapToFsrsGrade(5), 4);
});

Deno.test("mapToFsrsGrade: negative grade maps to 1 (Again)", () => {
  assertEquals(mapToFsrsGrade(-5), 1);
});

Deno.test("mapToFsrsGrade: large grade maps to 4 (Easy)", () => {
  assertEquals(mapToFsrsGrade(100), 4);
});

// ─── Test Suite: validateReviewItem ──────────────────────────────

Deno.test("validateReviewItem: valid item with all fields", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 3,
    response_time_ms: 1500,
    subtopic_id: "550e8400-e29b-41d4-a716-446655440001",
  };

  const result = validateReviewItem(item, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid?.item_id, item.item_id);
  assertEquals(result.valid?.instrument_type, item.instrument_type);
  assertEquals(result.valid?.grade, 3);
  assertEquals(result.valid?.response_time_ms, 1500);
  assertEquals(result.valid?.subtopic_id, item.subtopic_id);
});

Deno.test("validateReviewItem: valid item without optional fields", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "quiz",
    grade: 2,
  };

  const result = validateReviewItem(item, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid?.item_id, item.item_id);
  assertEquals(result.valid?.response_time_ms, undefined);
  assertEquals(result.valid?.subtopic_id, undefined);
});

Deno.test("validateReviewItem: invalid item_id (not UUID)", () => {
  const item = {
    item_id: "not-a-uuid",
    instrument_type: "flashcard",
    grade: 3,
  };

  const result = validateReviewItem(item, 0);
  assertEquals(result.error, "reviews[0].item_id must be a valid UUID");
  assertEquals(result.valid, null);
});

Deno.test("validateReviewItem: missing item_id", () => {
  const item = {
    instrument_type: "flashcard",
    grade: 3,
  };

  const result = validateReviewItem(item, 5);
  assertEquals(result.error, "reviews[5].item_id must be a valid UUID");
  assertEquals(result.valid, null);
});

Deno.test("validateReviewItem: empty instrument_type", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "",
    grade: 3,
  };

  const result = validateReviewItem(item, 2);
  assertEquals(result.error, "reviews[2].instrument_type must be a non-empty string");
  assertEquals(result.valid, null);
});

Deno.test("validateReviewItem: whitespace-only instrument_type", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "   ",
    grade: 3,
  };

  const result = validateReviewItem(item, 1);
  assertEquals(result.error, "reviews[1].instrument_type must be a non-empty string");
});

Deno.test("validateReviewItem: grade below 0", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: -1,
  };

  const result = validateReviewItem(item, 0);
  assertEquals(result.error, "reviews[0].grade must be in [0, 5]");
});

Deno.test("validateReviewItem: grade above 5", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 6,
  };

  const result = validateReviewItem(item, 3);
  assertEquals(result.error, "reviews[3].grade must be in [0, 5]");
});

Deno.test("validateReviewItem: grade boundary 0 is valid", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 0,
  };

  const result = validateReviewItem(item, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid?.grade, 0);
});

Deno.test("validateReviewItem: grade boundary 5 is valid", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 5,
  };

  const result = validateReviewItem(item, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid?.grade, 5);
});

Deno.test("validateReviewItem: response_time_ms negative", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 3,
    response_time_ms: -500,
  };

  const result = validateReviewItem(item, 1);
  assertEquals(result.error, "reviews[1].response_time_ms must be a non-negative integer");
});

Deno.test("validateReviewItem: response_time_ms float", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 3,
    response_time_ms: 1500.5,
  };

  const result = validateReviewItem(item, 0);
  assertEquals(result.error, "reviews[0].response_time_ms must be a non-negative integer");
});

Deno.test("validateReviewItem: response_time_ms zero is valid", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 3,
    response_time_ms: 0,
  };

  const result = validateReviewItem(item, 0);
  assertEquals(result.error, null);
  assertEquals(result.valid?.response_time_ms, 0);
});

Deno.test("validateReviewItem: subtopic_id invalid UUID", () => {
  const item = {
    item_id: "550e8400-e29b-41d4-a716-446655440000",
    instrument_type: "flashcard",
    grade: 3,
    subtopic_id: "invalid-uuid",
  };

  const result = validateReviewItem(item, 2);
  assertEquals(result.error, "reviews[2].subtopic_id must be a valid UUID");
});

Deno.test("validateReviewItem: error message includes array index", () => {
  const item = {
    item_id: "invalid",
    instrument_type: "flashcard",
    grade: 3,
  };

  const result = validateReviewItem(item, 42);
  assertEquals(result.error?.includes("reviews[42]"), true);
});

// ─── Test Suite: Constants ──────────────────────────────────────

Deno.test("MAX_BATCH_SIZE is 100", () => {
  assertEquals(MAX_BATCH_SIZE, 100);
});

Deno.test("FSRS_STATES contains all 4 states", () => {
  assertEquals(FSRS_STATES.length, 4);
  assertEquals(FSRS_STATES.includes("new"), true);
  assertEquals(FSRS_STATES.includes("learning"), true);
  assertEquals(FSRS_STATES.includes("review"), true);
  assertEquals(FSRS_STATES.includes("relearning"), true);
});

Deno.test("DEFAULT_LEECH_THRESHOLD is 8", () => {
  assertEquals(DEFAULT_LEECH_THRESHOLD, 8);
});
