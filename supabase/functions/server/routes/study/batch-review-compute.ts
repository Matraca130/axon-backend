/**
 * routes/study/batch-review-compute.ts — Pure FSRS/BKT compute + row dedupe
 *
 * Extracted from batch-review.ts. Contains the per-item FSRS v4 Petrick
 * and BKT v4 Recovery computations plus the pre-RPC dedupe of upsert rows.
 * ZERO DB ACCESS — all state is passed in as Maps by the caller.
 *
 * Why extract:
 *   - Unit-testable: every effect goes through injected inputs/outputs.
 *   - Deterministic: `nowFn` is injectable (production uses `() => new Date()`;
 *     tests inject a fixed clock). Note it's called PER ITEM (not once per
 *     batch) to match the pre-refactor behavior where `new Date()` ran
 *     inside the loop and thus advanced between items.
 *   - Decoupled: RPC payload shape is the only contract with the handler.
 *
 * Invariants preserved from the original loop:
 *   1. `successfulReviews.push` fires OUTSIDE the FSRS/BKT try blocks, so
 *      even if both computes throw, the review row is still queued for
 *      insertion (the RPC decides whether it actually lands).
 *   2. `bktMap.set` and `propagationByKeyword.set` fire INSIDE the BKT try
 *      block, so a throw aborts both side-effects for that item.
 *   3. Pair logic in `computedResults`: FSRS always pushes a new entry;
 *      BKT updates the last-pushed entry iff its `item_id` matches the
 *      current item, else it pushes a BKT-only entry.
 *   4. `bktMap` mutation chains forward within the same batch (two items
 *      on the same subtopic read the updated p_know/counters).
 *   5. Dedup: BKT last-wins on p_know/max_p_know/delta, SUM on counters.
 *      FSRS last-wins on flashcard_id.
 */

import { computeFsrsV4Update } from "../../lib/fsrs-v4.ts";
import { computeBktV4Update } from "../../lib/bkt-v4.ts";
import { THRESHOLDS } from "../../lib/types.ts";
import type { FsrsCardState } from "../../lib/types.ts";
import type { ReviewItem, ComputedResult } from "./batch-review-validators.ts";
import { mapToFsrsGrade } from "./batch-review-validators.ts";

// ─── Row Payload Types (RPC contract) ─────────────────────────

export interface ReviewRowPayload {
  item_id: string;
  instrument_type: string;
  grade: number;
  response_time_ms?: number;
}

export interface FsrsRowPayload {
  student_id: string;
  flashcard_id: string;
  stability: number;
  difficulty: number;
  due_at: string;
  last_review_at: string;
  reps: number;
  lapses: number;
  state: string;
  consecutive_lapses: number;
  is_leech: boolean;
}

export interface BktRowPayload {
  student_id: string;
  subtopic_id: string;
  p_know: number;
  max_p_know: number;
  p_transit: number;
  p_slip: number;
  p_guess: number;
  delta: number;
  total_delta: number;   // +1 per review, added to existing counter in RPC
  correct_delta: number; // 0 or 1, added to existing counter in RPC
  last_attempt_at: string;
}

// ─── Pre-loaded state row shapes (subset of DB columns we read) ─

export interface FsrsStateRow {
  flashcard_id: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: string;
  last_review_at: string | null;
  consecutive_lapses: number;
  is_leech: boolean;
}

export interface BktStateRow {
  subtopic_id: string;
  p_know: number;
  max_p_know: number;
  total_attempts: number;
  correct_attempts: number;
  p_transit: number;
  p_slip: number;
  p_guess: number;
}

// ─── Keyword propagation intent (one entry per unique keyword_id) ─

export interface PropagationIntent {
  itemId: string;
  instrumentType: string;
  isCorrect: boolean;
  sourceSubtopicId?: string;
}

// ─── Compute inputs & outputs ─────────────────────────────────

export interface ComputeInput {
  validatedItems: ReviewItem[];
  userId: string;
  leechThreshold: number;
  /** Pre-loaded FSRS states, mutated in-place is NOT expected here. */
  fsrsMap: Map<string, FsrsStateRow>;
  /**
   * Pre-loaded BKT states. MUTATED IN-PLACE within compute so the next
   * item sharing a subtopic reads the chained-forward state.
   */
  bktMap: Map<string, BktStateRow>;
  /** itemId → keyword_id for all items that have one. */
  itemKeywordMap: Map<string, string>;
  /**
   * Clock factory. Called per item to match pre-refactor behavior
   * (`new Date()` inside the loop advances between items).
   */
  nowFn?: () => Date;
}

export interface ComputeError {
  index: number;
  step: string;
  message: string;
}

export interface SuccessfulReview {
  item_id: string;
  grade: number;
  instrument_type: string;
}

export interface ComputeOutput {
  reviewRows: ReviewRowPayload[];
  fsrsRows: FsrsRowPayload[];
  bktRows: BktRowPayload[];
  computedResults: ComputedResult[];
  errors: ComputeError[];
  successfulReviews: SuccessfulReview[];
  propagationByKeyword: Map<string, PropagationIntent>;
}

// ═══════════════════════════════════════════════════════════════
// computeReviewBatch — the extracted per-item loop
// ═══════════════════════════════════════════════════════════════

export function computeReviewBatch(input: ComputeInput): ComputeOutput {
  const {
    validatedItems,
    userId,
    leechThreshold,
    fsrsMap,
    bktMap,
    itemKeywordMap,
    nowFn = () => new Date(),
  } = input;

  const reviewRows: ReviewRowPayload[] = [];
  const fsrsRows: FsrsRowPayload[] = [];
  const bktRows: BktRowPayload[] = [];
  const computedResults: ComputedResult[] = [];
  const errors: ComputeError[] = [];
  const successfulReviews: SuccessfulReview[] = [];
  const propagationByKeyword = new Map<string, PropagationIntent>();

  for (let i = 0; i < validatedItems.length; i++) {
    const item = validatedItems[i];
    const now = nowFn();
    const nowIso = now.toISOString();

    // ── Step A: review row payload (no DB call) ──
    const reviewRow: ReviewRowPayload = {
      item_id: item.item_id,
      instrument_type: item.instrument_type,
      grade: item.grade,
    };
    if (item.response_time_ms !== undefined) {
      reviewRow.response_time_ms = item.response_time_ms;
    }
    reviewRows.push(reviewRow);

    // Tracked for the XP hook. Pushed OUTSIDE the FSRS/BKT try blocks
    // to preserve the pre-refactor contract: XP fires for every queued
    // review regardless of whether FSRS/BKT compute throws.
    successfulReviews.push({
      item_id: item.item_id,
      grade: item.grade,
      instrument_type: item.instrument_type,
    });

    // ── Step B: compute FSRS v4 Petrick update ──
    try {
      const existingFsrs = fsrsMap.get(item.item_id) ?? null;

      // BKT recovery cross-signal (from pre-loaded map)
      let isRecovering = false;
      if (item.subtopic_id) {
        const existingBkt = bktMap.get(item.subtopic_id) ?? null;
        if (existingBkt) {
          const maxPKnow = existingBkt.max_p_know ?? 0;
          const pKnow = existingBkt.p_know ?? 0;
          isRecovering = maxPKnow > 0.50 && pKnow < maxPKnow;
        }
      }

      const fsrsGrade = mapToFsrsGrade(item.grade);

      const fsrsResult = computeFsrsV4Update({
        currentStability: existingFsrs?.stability ?? 0,
        currentDifficulty: existingFsrs?.difficulty ?? 5.0,
        currentReps: existingFsrs?.reps ?? 0,
        currentLapses: existingFsrs?.lapses ?? 0,
        currentState: (existingFsrs?.state as FsrsCardState) ?? "new",
        lastReviewAt: existingFsrs?.last_review_at ?? null,
        grade: fsrsGrade,
        isRecovering,
        now,
      });

      // Leech detection (v4.2)
      const prevConsecutiveLapses = existingFsrs?.consecutive_lapses ?? 0;
      const newConsecutiveLapses = fsrsGrade === 1 ? prevConsecutiveLapses + 1 : 0;
      const newIsLeech = newConsecutiveLapses >= leechThreshold;

      fsrsRows.push({
        student_id: userId,
        flashcard_id: item.item_id,
        stability: fsrsResult.stability,
        difficulty: fsrsResult.difficulty,
        due_at: fsrsResult.due_at,
        last_review_at: fsrsResult.last_review_at,
        reps: fsrsResult.reps,
        lapses: fsrsResult.lapses,
        state: fsrsResult.state,
        consecutive_lapses: newConsecutiveLapses,
        is_leech: newIsLeech,
      });

      computedResults.push({
        item_id: item.item_id,
        fsrs: {
          stability: fsrsResult.stability,
          difficulty: fsrsResult.difficulty,
          due_at: fsrsResult.due_at,
          state: fsrsResult.state,
          reps: fsrsResult.reps,
          lapses: fsrsResult.lapses,
          consecutive_lapses: newConsecutiveLapses,
          is_leech: newIsLeech,
        },
      });
    } catch (e) {
      errors.push({ index: i, step: "fsrs", message: (e as Error).message });
    }

    // ── Step C: compute BKT v4 Recovery update ──
    if (item.subtopic_id) {
      try {
        const fsrsGrade = mapToFsrsGrade(item.grade);
        const isCorrect = fsrsGrade >= THRESHOLDS.BKT_CORRECT_MIN_GRADE;
        const instrumentType =
          item.instrument_type === "quiz" ? "quiz" as const : "flashcard" as const;

        const existingBkt = bktMap.get(item.subtopic_id) ?? null;

        const currentMastery = existingBkt?.p_know ?? 0;
        const maxReachedMastery = existingBkt?.max_p_know ?? 0;

        const bktResult = computeBktV4Update({
          currentMastery,
          maxReachedMastery,
          isCorrect,
          instrumentType,
        });

        const correctDelta = isCorrect ? 1 : 0;

        bktRows.push({
          student_id: userId,
          subtopic_id: item.subtopic_id,
          p_know: bktResult.p_know,
          max_p_know: bktResult.max_p_know,
          p_transit: existingBkt?.p_transit ?? 0.18,
          p_slip: existingBkt?.p_slip ?? 0.10,
          p_guess: existingBkt?.p_guess ?? 0.25,
          delta: bktResult.delta,
          // Counter deltas: the RPC adds these to existing counters
          // atomically in the ON CONFLICT clause of the upsert.
          total_delta: 1,
          correct_delta: correctDelta,
          last_attempt_at: nowIso,
        });

        // 2.7: Update bktMap so next item with same subtopic reads
        // fresh in-memory state during computation. Counters use
        // existing + delta projection (DB commits the same values).
        bktMap.set(item.subtopic_id, {
          ...(existingBkt ?? {}),
          subtopic_id: item.subtopic_id,
          p_know: bktResult.p_know,
          max_p_know: bktResult.max_p_know,
          p_transit: existingBkt?.p_transit ?? 0.18,
          p_slip: existingBkt?.p_slip ?? 0.10,
          p_guess: existingBkt?.p_guess ?? 0.25,
          total_attempts: (existingBkt?.total_attempts ?? 0) + 1,
          correct_attempts: (existingBkt?.correct_attempts ?? 0) + correctDelta,
        });

        // Record keyword intent for post-commit propagation (fix #3).
        const keywordIdForItem = itemKeywordMap.get(item.item_id);
        if (keywordIdForItem) {
          propagationByKeyword.set(keywordIdForItem, {
            itemId: item.item_id,
            instrumentType: item.instrument_type,
            isCorrect,
            sourceSubtopicId: item.subtopic_id,
          });
        }

        const lastResult = computedResults[computedResults.length - 1];
        if (lastResult && lastResult.item_id === item.item_id) {
          lastResult.bkt = {
            subtopic_id: item.subtopic_id,
            p_know: bktResult.p_know,
            max_p_know: bktResult.max_p_know,
            delta: bktResult.delta,
          };
        } else {
          computedResults.push({
            item_id: item.item_id,
            bkt: {
              subtopic_id: item.subtopic_id,
              p_know: bktResult.p_know,
              max_p_know: bktResult.max_p_know,
              delta: bktResult.delta,
            },
          });
        }
      } catch (e) {
        errors.push({ index: i, step: "bkt", message: (e as Error).message });
      }
    }
  }

  return {
    reviewRows,
    fsrsRows,
    bktRows,
    computedResults,
    errors,
    successfulReviews,
    propagationByKeyword,
  };
}

// ═══════════════════════════════════════════════════════════════
// dedupePayloads — collapse conflicting rows before the RPC
// ═══════════════════════════════════════════════════════════════
// Postgres errors ("ON CONFLICT DO UPDATE command cannot affect row
// a second time") if a single INSERT...ON CONFLICT statement contains
// two rows that conflict with each other on the same unique key.
// A batch of N flashcards under the same subtopic produces N bktRows
// with the same (student_id, subtopic_id) — so we collapse them here.
//
// Rules:
//   - For (student_id, subtopic_id): keep the LAST computed p_know /
//     max_p_know / delta (they already chain forward via the in-memory
//     bktMap), and SUM total_delta / correct_delta across all entries.
//   - For (student_id, flashcard_id) on FSRS: defensively keep the
//     last row (same item shouldn't appear twice, but we guard anyway).

export interface DedupedPayloads {
  dedupedFsrsRows: FsrsRowPayload[];
  dedupedBktRows: BktRowPayload[];
}

export function dedupePayloads(input: {
  fsrsRows: FsrsRowPayload[];
  bktRows: BktRowPayload[];
}): DedupedPayloads {
  const { fsrsRows, bktRows } = input;

  const bktDeduped = new Map<string, BktRowPayload>();
  for (const row of bktRows) {
    const key = `${row.student_id}|${row.subtopic_id}`;
    const existing = bktDeduped.get(key);
    if (existing) {
      row.total_delta = existing.total_delta + row.total_delta;
      row.correct_delta = existing.correct_delta + row.correct_delta;
    }
    bktDeduped.set(key, row);
  }

  const fsrsDeduped = new Map<string, FsrsRowPayload>();
  for (const row of fsrsRows) {
    fsrsDeduped.set(`${row.student_id}|${row.flashcard_id}`, row);
  }

  return {
    dedupedFsrsRows: [...fsrsDeduped.values()],
    dedupedBktRows: [...bktDeduped.values()],
  };
}

// ═══════════════════════════════════════════════════════════════
// selectBatchResponseStatus — pure HTTP status + body shaping
// ═══════════════════════════════════════════════════════════════

/**
 * Shapes the final HTTP response for a batch review request.
 *
 * Tri-state selection:
 *   - Every item failed (errors.length > 0 && reviewsCreated === 0) → 500
 *   - Some items failed (errors.length > 0 && reviewsCreated > 0)   → 207
 *   - Otherwise                                                     → 200
 *
 * `reviewsCreated === 0` is the strongest "nothing persisted" signal: without
 * a review row, downstream FSRS/BKT upserts would be semantically orphan, so
 * the RPC declining to insert is treated as a full rollback.
 *
 * Pure — no Hono/Context coupling. The handler adapts the returned
 * `{ status, body }` into the framework-specific response.
 */
export interface BatchPersistSummary {
  reviewsCreated: number;
  fsrsUpdated: number;
  bktUpdated: number;
}

export interface BatchResponseInput {
  processed: number;
  errors: ComputeError[];
  computedResults: ComputedResult[];
  persist: BatchPersistSummary;
  propagationWarnings: string[];
}

export interface BatchResponseSelection {
  status: 200 | 207 | 500;
  body: Record<string, unknown>;
}

export function selectBatchResponseStatus(
  input: BatchResponseInput,
): BatchResponseSelection {
  const { processed, errors, computedResults, persist, propagationWarnings } = input;

  const hasPartialFailure = errors.length > 0 && persist.reviewsCreated > 0;
  const totalFailure = errors.length > 0 && persist.reviewsCreated === 0;

  const body: Record<string, unknown> = {
    processed,
    reviews_created: persist.reviewsCreated,
    fsrs_updated: persist.fsrsUpdated,
    bkt_updated: persist.bktUpdated,
    errors: errors.length > 0 ? errors : undefined,
    results: computedResults.length > 0 ? computedResults : undefined,
    propagation_warnings: propagationWarnings.length > 0 ? propagationWarnings : undefined,
  };

  if (totalFailure) {
    return { status: 500, body: { error: "All reviews in batch failed", ...body } };
  }
  if (hasPartialFailure) {
    return { status: 207, body };
  }
  return { status: 200, body };
}
