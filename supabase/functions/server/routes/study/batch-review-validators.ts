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
 *   ComputedResult         — PATH B computed result type
 *   mapToFsrsGrade         — Maps 0-5 grade to FSRS 1-4 grade
 *   validateReviewItem     — Validates a single review item
 *
 * Run tests: deno test supabase/functions/server/tests/batch_review_validators_test.ts
 */

import {
  isUuid,
  isNum,
  isNonNegInt,
  isIsoTs,
  isProbability,
  inRange,
  isOneOf,
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
  fsrs_update?: {
    stability: number;
    difficulty: number;
    due_at: string;
    last_review_at: string;
    reps: number;
    lapses: number;
    state: string;
  };
  bkt_update?: {
    subtopic_id: string;
    p_know: number;
    p_transit: number;
    p_slip: number;
    p_guess: number;
    delta: number;
    total_attempts: number;
    correct_attempts: number;
    last_attempt_at: string;
  };
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

// ─── Grade Mapping (PATH B) ──────────────────────────────────────

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
  if (!inRange(item.grade, 0, 5))
    return { valid: null, error: `${prefix}.grade must be in [0, 5]` };
  if (item.response_time_ms !== undefined && !isNonNegInt(item.response_time_ms))
    return { valid: null, error: `${prefix}.response_time_ms must be a non-negative integer` };

  let subtopicId: string | undefined = undefined;
  if (item.subtopic_id !== undefined) {
    if (!isUuid(item.subtopic_id))
      return { valid: null, error: `${prefix}.subtopic_id must be a valid UUID` };
    subtopicId = item.subtopic_id as string;
  }

  // Validate fsrs_update if present (PATH A)
  let fsrsUpdate: ReviewItem["fsrs_update"] = undefined;
  if (item.fsrs_update && typeof item.fsrs_update === "object") {
    const f = item.fsrs_update as Record<string, unknown>;
    if (!isNum(f.stability) || (f.stability as number) <= 0)
      return { valid: null, error: `${prefix}.fsrs_update.stability must be a positive number` };
    if (!inRange(f.difficulty, 0, 10))
      return { valid: null, error: `${prefix}.fsrs_update.difficulty must be in [0, 10]` };
    if (!isIsoTs(f.due_at))
      return { valid: null, error: `${prefix}.fsrs_update.due_at must be an ISO timestamp` };
    if (!isIsoTs(f.last_review_at))
      return { valid: null, error: `${prefix}.fsrs_update.last_review_at must be an ISO timestamp` };
    if (!isNonNegInt(f.reps))
      return { valid: null, error: `${prefix}.fsrs_update.reps must be a non-negative integer` };
    if (!isNonNegInt(f.lapses))
      return { valid: null, error: `${prefix}.fsrs_update.lapses must be a non-negative integer` };
    if (!isOneOf(f.state, FSRS_STATES))
      return { valid: null, error: `${prefix}.fsrs_update.state must be one of: ${FSRS_STATES.join(", ")}` };

    fsrsUpdate = {
      stability: f.stability as number,
      difficulty: f.difficulty as number,
      due_at: f.due_at as string,
      last_review_at: f.last_review_at as string,
      reps: f.reps as number,
      lapses: f.lapses as number,
      state: f.state as string,
    };
  }

  // Validate bkt_update if present (PATH A)
  let bktUpdate: ReviewItem["bkt_update"] = undefined;
  if (item.bkt_update && typeof item.bkt_update === "object") {
    const b = item.bkt_update as Record<string, unknown>;
    if (!isUuid(b.subtopic_id))
      return { valid: null, error: `${prefix}.bkt_update.subtopic_id must be a valid UUID` };
    if (!isProbability(b.p_know))
      return { valid: null, error: `${prefix}.bkt_update.p_know must be in [0, 1]` };
    if (!isProbability(b.p_transit))
      return { valid: null, error: `${prefix}.bkt_update.p_transit must be in [0, 1]` };
    if (!isProbability(b.p_slip))
      return { valid: null, error: `${prefix}.bkt_update.p_slip must be in [0, 1]` };
    if (!isProbability(b.p_guess))
      return { valid: null, error: `${prefix}.bkt_update.p_guess must be in [0, 1]` };
    if (!isNum(b.delta))
      return { valid: null, error: `${prefix}.bkt_update.delta must be a finite number` };
    if (!isNonNegInt(b.total_attempts))
      return { valid: null, error: `${prefix}.bkt_update.total_attempts must be a non-negative integer` };
    if (!isNonNegInt(b.correct_attempts))
      return { valid: null, error: `${prefix}.bkt_update.correct_attempts must be a non-negative integer` };
    if (!isIsoTs(b.last_attempt_at))
      return { valid: null, error: `${prefix}.bkt_update.last_attempt_at must be an ISO timestamp` };

    bktUpdate = {
      subtopic_id: b.subtopic_id as string,
      p_know: b.p_know as number,
      p_transit: b.p_transit as number,
      p_slip: b.p_slip as number,
      p_guess: b.p_guess as number,
      delta: b.delta as number,
      total_attempts: b.total_attempts as number,
      correct_attempts: b.correct_attempts as number,
      last_attempt_at: b.last_attempt_at as string,
    };
  }

  return {
    valid: {
      item_id: item.item_id as string,
      instrument_type: item.instrument_type as string,
      grade: item.grade as number,
      response_time_ms: item.response_time_ms as number | undefined,
      subtopic_id: subtopicId,
      fsrs_update: fsrsUpdate,
      bkt_update: bktUpdate,
    },
    error: null,
  };
}
