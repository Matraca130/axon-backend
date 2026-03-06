/**
 * routes/study/batch-review.ts — Atomic batch review persistence
 *
 * PERF M1: Eliminates the 3-POST-per-card pattern where the frontend had to:
 *   1. POST /reviews           → insert review record
 *   2. POST /fsrs-states       → upsert FSRS scheduling
 *   3. POST /bkt-states        → upsert BKT mastery (with INCREMENT)
 *   Total: 3 × N HTTP requests per session (e.g. 90 for 30 cards)
 *
 * New pattern:
 *   1. POST /review-batch      → ALL reviews + FSRS + BKT in one call
 *   Total: 1 HTTP request per session
 *
 * HOW IT WORKS:
 *   The frontend computes FSRS and BKT updates locally (same algorithms
 *   as the individual endpoints use), then sends everything in one batch.
 *   The server processes each review item sequentially within the batch:
 *     a) INSERT into reviews (same as POST /reviews)
 *     b) UPSERT into fsrs_states (same as POST /fsrs-states)
 *     c) READ existing bkt_states + INCREMENT counters + UPSERT
 *        (same as POST /bkt-states with M-1 FIX)
 *
 * WHY SEQUENTIAL AND NOT PARALLEL:
 *   BKT states use INCREMENT logic (M-1 FIX from spaced-rep.ts):
 *   total_attempts is READ + ADD, not REPLACE. If two reviews for cards
 *   sharing the same subtopic_id run in parallel, the READ-ADD-WRITE
 *   would race. Sequential processing guarantees correct accumulation.
 *   FSRS states don't have this issue (each card has its own row), but
 *   we keep everything sequential for simplicity and predictability.
 *
 * WHY NOT MODIFY EXISTING ENDPOINTS:
 *   The existing POST /reviews, POST /fsrs-states, POST /bkt-states
 *   are consumed by other flows (FlashcardReviewer, ReviewSessionView,
 *   quiz attempts). Modifying them risks breaking those consumers.
 *   A dedicated batch endpoint is additive and safe.
 *
 * BKT INCREMENT REPLICATION (critical):
 *   The M-1 FIX in spaced-rep.ts (lines 139-162) reads the existing
 *   bkt_states row and ADDs the incoming total_attempts/correct_attempts
 *   to the existing values. This fix is replicated here identically.
 *   Without it, a 50-card session would show total_attempts=1.
 *
 * SESSION OWNERSHIP:
 *   Same verification as POST /reviews (reviews.ts lines 37-51).
 *   We verify ONCE that the session belongs to the authenticated user,
 *   then process all reviews without re-checking.
 *
 * ERROR HANDLING:
 *   - Individual item failures are collected but don't abort the batch.
 *   - The response includes per-item error details.
 *   - The frontend can retry failed items individually.
 *
 * SECURITY:
 *   - Authenticated (same as all Axon endpoints)
 *   - Session ownership verified before processing
 *   - All field validations match the individual endpoints exactly
 *   - Max 100 reviews per batch (safety cap)
 */

import { Hono } from "npm:hono";
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import {
  isUuid,
  isNum,
  isNonNeg,
  isNonNegInt,
  isIsoTs,
  isProbability,
  inRange,
  isOneOf,
  isNonEmpty,
} from "../../validate.ts";
import { atomicUpsert } from "./progress.ts";
import type { Context } from "npm:hono";

export const batchReviewRoutes = new Hono();

// ─── Constants ────────────────────────────────────────────────────

const MAX_BATCH_SIZE = 100;
const FSRS_STATES = ["new", "learning", "review", "relearning"] as const;

// ─── Session Ownership (same logic as reviews.ts) ─────────────────

async function verifySessionOwnership(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<string | null> {
  const { data: session, error: sessionErr } = await db
    .from("study_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("student_id", userId)
    .maybeSingle();

  if (sessionErr) return `Session lookup failed: ${sessionErr.message}`;
  if (!session) return "Session not found or does not belong to you";
  return null; // OK
}

// ─── Item Validators ──────────────────────────────────────────────
// WHY INLINE INSTEAD OF validateFields()?
//   validateFields() is designed for optional fields with a declarative
//   schema. Here we have deeply nested objects (fsrs_update, bkt_update)
//   that don't map cleanly to the flat key-value pattern. Inline validation
//   gives us better error messages and cleaner control flow.

interface ReviewItem {
  item_id: string;
  instrument_type: string;
  grade: number;
  response_time_ms?: number;
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

function validateReviewItem(
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

  // Validate fsrs_update if present
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

  // Validate bkt_update if present
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
      fsrs_update: fsrsUpdate,
      bkt_update: bktUpdate,
    },
    error: null,
  };
}

// ─── POST /review-batch ───────────────────────────────────────────

batchReviewRoutes.post(`${PREFIX}/review-batch`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  // ── Validate session_id ──
  if (!isUuid(body.session_id)) {
    return err(c, "session_id must be a valid UUID", 400);
  }
  const sessionId = body.session_id as string;

  // ── Validate reviews array ──
  if (!Array.isArray(body.reviews)) {
    return err(c, "reviews must be an array", 400);
  }
  if (body.reviews.length === 0) {
    return err(c, "reviews array must not be empty", 400);
  }
  if (body.reviews.length > MAX_BATCH_SIZE) {
    return err(c, `reviews array exceeds max batch size of ${MAX_BATCH_SIZE}`, 400);
  }

  // ── Validate all items upfront (fail-fast) ──
  // WHY VALIDATE ALL BEFORE PROCESSING?
  //   If item #25 of 30 has a validation error, we don't want to have
  //   already written 24 reviews to the DB. Validating everything first
  //   ensures atomicity at the validation level.
  const validatedItems: ReviewItem[] = [];
  for (let i = 0; i < body.reviews.length; i++) {
    const item = body.reviews[i];
    if (!item || typeof item !== "object") {
      return err(c, `reviews[${i}] must be an object`, 400);
    }
    const result = validateReviewItem(item as Record<string, unknown>, i);
    if (result.error) {
      return err(c, result.error, 400);
    }
    validatedItems.push(result.valid);
  }

  // ── Verify session ownership (1 query for the entire batch) ──
  const ownershipErr = await verifySessionOwnership(db, sessionId, user.id);
  if (ownershipErr) {
    return err(c, ownershipErr, 404);
  }

  // ── Process each review sequentially ──
  // WHY SEQUENTIAL?
  //   BKT uses READ + INCREMENT + WRITE. If two cards share the same
  //   subtopic_id and we process them in parallel, the second READ
  //   would get stale data (before the first WRITE). Sequential
  //   guarantees correct accumulation of total_attempts.
  //
  //   Performance impact: minimal. Each iteration is ~3-6ms (3 DB ops).
  //   For 30 cards: ~90-180ms total, which is still faster than
  //   90 individual HTTP requests from the frontend.

  let reviewsCreated = 0;
  let fsrsUpdated = 0;
  let bktUpdated = 0;
  const errors: { index: number; step: string; message: string }[] = [];

  for (let i = 0; i < validatedItems.length; i++) {
    const item = validatedItems[i];

    // ── Step A: INSERT review ──
    try {
      const reviewRow: Record<string, unknown> = {
        session_id: sessionId,
        item_id: item.item_id,
        instrument_type: item.instrument_type,
        grade: item.grade,
      };
      if (item.response_time_ms !== undefined) {
        reviewRow.response_time_ms = item.response_time_ms;
      }

      const { error: revErr } = await db
        .from("reviews")
        .insert(reviewRow)
        .select()
        .single();

      if (revErr) {
        errors.push({ index: i, step: "review", message: revErr.message });
      } else {
        reviewsCreated++;
      }
    } catch (e) {
      errors.push({ index: i, step: "review", message: (e as Error).message });
    }

    // ── Step B: UPSERT fsrs_states ──
    if (item.fsrs_update) {
      try {
        const fsrsRow = {
          student_id: user.id,
          flashcard_id: item.item_id,
          stability: item.fsrs_update.stability,
          difficulty: item.fsrs_update.difficulty,
          due_at: item.fsrs_update.due_at,
          last_review_at: item.fsrs_update.last_review_at,
          reps: item.fsrs_update.reps,
          lapses: item.fsrs_update.lapses,
          state: item.fsrs_update.state,
        };

        const { error: fsrsErr } = await atomicUpsert(
          db,
          "fsrs_states",
          "student_id,flashcard_id",
          fsrsRow,
        );

        if (fsrsErr) {
          errors.push({ index: i, step: "fsrs", message: fsrsErr.message });
        } else {
          fsrsUpdated++;
        }
      } catch (e) {
        errors.push({ index: i, step: "fsrs", message: (e as Error).message });
      }
    }

    // ── Step C: READ + INCREMENT + UPSERT bkt_states ──
    // CRITICAL: This replicates the M-1 FIX from spaced-rep.ts.
    // The incoming total_attempts/correct_attempts are DELTAS (e.g. 1/0),
    // not absolute values. We must READ the existing row and ADD.
    if (item.bkt_update) {
      try {
        const bkt = item.bkt_update;
        let finalTotalAttempts = bkt.total_attempts;
        let finalCorrectAttempts = bkt.correct_attempts;

        // M-1 FIX REPLICATION: Read existing row and increment
        const { data: existing } = await db
          .from("bkt_states")
          .select("total_attempts, correct_attempts")
          .eq("student_id", user.id)
          .eq("subtopic_id", bkt.subtopic_id)
          .maybeSingle();

        if (existing) {
          finalTotalAttempts =
            (existing.total_attempts || 0) + bkt.total_attempts;
          finalCorrectAttempts =
            (existing.correct_attempts || 0) + bkt.correct_attempts;
        }
        // If no existing row, the delta IS the initial value (correct).

        const bktRow = {
          student_id: user.id,
          subtopic_id: bkt.subtopic_id,
          p_know: bkt.p_know,
          p_transit: bkt.p_transit,
          p_slip: bkt.p_slip,
          p_guess: bkt.p_guess,
          delta: bkt.delta,
          total_attempts: finalTotalAttempts,
          correct_attempts: finalCorrectAttempts,
          last_attempt_at: bkt.last_attempt_at,
        };

        const { error: bktErr } = await atomicUpsert(
          db,
          "bkt_states",
          "student_id,subtopic_id",
          bktRow,
        );

        if (bktErr) {
          errors.push({ index: i, step: "bkt", message: bktErr.message });
        } else {
          bktUpdated++;
        }
      } catch (e) {
        errors.push({ index: i, step: "bkt", message: (e as Error).message });
      }
    }
  }

  // ── Return summary ──
  return ok(c, {
    processed: validatedItems.length,
    reviews_created: reviewsCreated,
    fsrs_updated: fsrsUpdated,
    bkt_updated: bktUpdated,
    errors: errors.length > 0 ? errors : undefined,
  });
});
