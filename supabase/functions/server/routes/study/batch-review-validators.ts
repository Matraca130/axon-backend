/**
 * routes/study/batch-review-validators.ts — Pure validation for batch reviews
 *
 * Extracted from batch-review.ts (PR #104) for testability.
 * Contains ONLY pure functions and types — zero DB access.
 *
 * Exports:
 *   MAX_BATCH_SIZE         — Max items per batch request (100)
 *   FSRS_STATES            — Valid FSRS state values
 *   DEFAULT_LEECH_THRESHOLD — Default leech detection threshold
 *   ReviewItem             — Validated review item type
 *   ComputedResult         — Server-computed result type
 *   mapToFsrsGrade         — Maps 0-5 grade to FSRS 1-4 grade
 *   validateReviewItem     — Validates a single review item
 *
 * NOTE: PATH A (legacy frontend pre-compute) was removed. The frontend
 * sends only grade + subtopic_id; the server computes FSRS v4 + BKT v4.
 *
 * Run tests: deno test supabase/functions/server/tests/batch_review_validators_test.ts
 */

import {
  isUuid,
  isNonNegInt,
  inRange,
  isNonEmpty,
} from "../../validate.ts";
import type { FsrsGrade } from "../../lib/types.ts";

// ─── Constants ────────────────────────────────────────────────────

export const MAX_BATCH_SIZE = 100;
export const FSRS_STATES = ["new", "learning", "review", "relearning"] as const;
export const DEFAULT_LEECH_THRESHOLD = 8;

// ─── Types ────────────────────────────────────────────────────────

export interface ReviewItem {
  item_id: string;
  instrument_type: string;
  grade: number;
  response_time_ms?: number;
  subtopic_id?: string;
}

export interface ComputedResult {
  item_id: string;
  fsrs?: {
    stability: number;
    difficulty: number;
    due_at: string;
    state: string;
    reps: number;
    lapses: number;
    consecutive_lapses: number;
    is_leech: boolean;
  };
  bkt?: {
    subtopic_id: string;
    p_know: number;
    max_p_know: number;
    delta: number;
  };
}

// ─── Grade Mapping ──────────────────────────────────────────────

export function mapToFsrsGrade(grade: number): FsrsGrade {
  if (grade <= 1) return 1; // Again
  if (grade === 2) return 2; // Hard
  if (grade === 3) return 3; // Good
  if (grade === 4) return 4; // Easy
  return 4; // Easy (SM-2 grade 5 legacy)
}

// ─── Item Validator ──────────────────────────────────────────────

export function validateReviewItem(
  item: Record<string, unknown>,
  index: number,
): { valid: ReviewItem; error: null } | { valid: null; error: string } {
  const prefix = `reviews[${index}]`;

  if (!isUuid(item.item_id))
    return { valid: null, error: `${prefix}.item_id must be a valid UUID` };
  if (!isNonEmpty(item.instrument_type))
    return { valid: null, error: `${prefix}.instrument_type must be a non-empty string` };
  // grade must be in [1, 5]. Rejecting 0 prevents silent collapse to FSRS "Again"
  // via mapToFsrsGrade — callers should send an explicit grade from the UI scale.
  if (!inRange(item.grade, 1, 5))
    return { valid: null, error: `${prefix}.grade must be in [1, 5]` };
  if (item.response_time_ms !== undefined && !isNonNegInt(item.response_time_ms))
    return { valid: null, error: `${prefix}.response_time_ms must be a non-negative integer` };

  let subtopicId: string | undefined = undefined;
  if (item.subtopic_id !== undefined) {
    if (!isUuid(item.subtopic_id))
      return { valid: null, error: `${prefix}.subtopic_id must be a valid UUID` };
    subtopicId = item.subtopic_id as string;
  }

  return {
    valid: {
      item_id: item.item_id as string,
      instrument_type: item.instrument_type as string,
      grade: item.grade as number,
      response_time_ms: item.response_time_ms as number | undefined,
      subtopic_id: subtopicId,
    },
    error: null,
  };
}
