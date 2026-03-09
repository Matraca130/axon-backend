/**
 * routes/study/batch-review.ts — Atomic batch review persistence
 *
 * DUAL PATH (Camino B, spec v4.2, plan v3.7 Fase 3):
 *
 *   PATH A (legacy): Frontend sends fsrs_update + bkt_update pre-computed
 *     → Server stores values as-is (current behavior, zero changes)
 *
 *   PATH B (new): Frontend sends only grade (+ optional subtopic_id)
 *     → Server computes FSRS v4 Petrick + BKT v4 Recovery using lib/
 *     → Server stores computed values
 *
 *   Detection: if item has fsrs_update → PATH A; else → PATH B
 *             if item has bkt_update → PATH A; else if subtopic_id → PATH B
 *
 * BACKWARD COMPATIBILITY:
 *   Old frontends that send fsrs_update/bkt_update continue working
 *   exactly as before. New frontends that send only grade get server-side
 *   computation. Both can coexist in the same batch.
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
 *   The frontend computes FSRS and BKT updates locally (PATH A), OR sends
 *   only the grade and the server computes everything (PATH B).
 *   The server processes each review item sequentially within the batch:
 *     a) INSERT into reviews (same as POST /reviews)
 *     b) UPSERT into fsrs_states (PATH A: pre-computed; PATH B: server-computed)
 *     c) READ existing bkt_states + INCREMENT counters + UPSERT
 *        (PATH A: pre-computed; PATH B: server-computed with BKT v4)
 *
 * WHY SEQUENTIAL AND NOT PARALLEL:
 *   BKT states use INCREMENT logic (M-1 FIX from spaced-rep.ts):
 *   total_attempts is READ + ADD, not REPLACE. If two reviews for cards
 *   sharing the same subtopic_id run in parallel, the READ-ADD-WRITE
 *   would race. Sequential processing guarantees correct accumulation.
 *
 * BKT INCREMENT REPLICATION (critical):
 *   The M-1 FIX in spaced-rep.ts reads the existing bkt_states row and
 *   ADDs the incoming total_attempts/correct_attempts to the existing
 *   values. This fix is replicated here identically for PATH A.
 *   PATH B computes BKT server-side and uses delta increments of 1.
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

// ── PATH B imports: server-side FSRS + BKT compute ──────────
import { computeFsrsV4Update } from "../../lib/fsrs-v4.ts";
import { computeBktV4Update } from "../../lib/bkt-v4.ts";
import { THRESHOLDS } from "../../lib/types.ts";
import type { FsrsGrade, FsrsCardState } from "../../lib/types.ts";

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

// ─── Grade Mapping (PATH B) ───────────────────────────────────────
// Frontend may send grade 0-5 (SM-2 scale). PATH B needs FsrsGrade 1-4.
// Mapping: 0→1(Again), 1→1(Again), 2→2(Hard), 3→3(Good), 4→3(Good), 5→4(Easy)

function mapToFsrsGrade(grade: number): FsrsGrade {
  if (grade <= 1) return 1; // Again
  if (grade === 2) return 2; // Hard
  if (grade === 3) return 3; // Good
  if (grade === 4) return 3; // Good (SM-2 "good" maps to FSRS "good")
  return 4; // Easy (SM-2 5 = perfect)
}

// ─── Item Validators ──────────────────────────────────────────────

interface ReviewItem {
  item_id: string;
  instrument_type: string;
  grade: number;
  response_time_ms?: number;
  /** Optional: subtopic_id for PATH B BKT compute (when bkt_update not sent) */
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

  // Validate optional subtopic_id for PATH B
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
  // WHY SEQUENTIAL? BKT uses READ + INCREMENT + WRITE.
  // If two cards share the same subtopic_id and we process them in
  // parallel, the second READ would get stale data.

  let reviewsCreated = 0;
  let fsrsUpdated = 0;
  let bktUpdated = 0;
  const errors: { index: number; step: string; message: string }[] = [];

  for (let i = 0; i < validatedItems.length; i++) {
    const item = validatedItems[i];
    const now = new Date();
    const nowIso = now.toISOString();

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
      // ════════════════════════════════════════════════════════
      // PATH A (legacy): frontend sent pre-computed fsrs_update
      // Store exactly as received — no server-side computation
      // ════════════════════════════════════════════════════════
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
    } else {
      // ════════════════════════════════════════════════════════
      // PATH B (new): no fsrs_update — compute FSRS server-side
      // Uses lib/fsrs-v4.ts (Petrick completo, spec v4.2)
      // ════════════════════════════════════════════════════════
      try {
        // 1. Read current FSRS state for this card (may not exist)
        const { data: existingFsrs } = await db
          .from("fsrs_states")
          .select("stability, difficulty, reps, lapses, state, last_review_at")
          .eq("student_id", user.id)
          .eq("flashcard_id", item.item_id)
          .maybeSingle();

        // 2. Read current BKT state for recovery cross-signal
        //    We need to resolve subtopic_id first
        let isRecovering = false;
        const resolvedSubtopicId = item.subtopic_id || item.bkt_update?.subtopic_id;
        if (resolvedSubtopicId) {
          const { data: existingBkt } = await db
            .from("bkt_states")
            .select("p_know, max_p_know")
            .eq("student_id", user.id)
            .eq("subtopic_id", resolvedSubtopicId)
            .maybeSingle();

          if (existingBkt) {
            const maxPKnow = existingBkt.max_p_know ?? 0;
            const pKnow = existingBkt.p_know ?? 0;
            isRecovering = maxPKnow > 0.50 && pKnow < maxPKnow;
          }
        }

        // 3. Map grade to FsrsGrade (1-4)
        const fsrsGrade = mapToFsrsGrade(item.grade);

        // 4. Compute FSRS v4 update
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

        // 5. UPSERT computed result
        const fsrsRow = {
          student_id: user.id,
          flashcard_id: item.item_id,
          stability: fsrsResult.stability,
          difficulty: fsrsResult.difficulty,
          due_at: fsrsResult.due_at,
          last_review_at: fsrsResult.last_review_at,
          reps: fsrsResult.reps,
          lapses: fsrsResult.lapses,
          state: fsrsResult.state,
        };

        const { error: fsrsErr } = await atomicUpsert(
          db,
          "fsrs_states",
          "student_id,flashcard_id",
          fsrsRow,
        );

        if (fsrsErr) {
          errors.push({ index: i, step: "fsrs_pathb", message: fsrsErr.message });
        } else {
          fsrsUpdated++;
        }
      } catch (e) {
        errors.push({ index: i, step: "fsrs_pathb", message: (e as Error).message });
      }
    }

    // ── Step C: READ + INCREMENT + UPSERT bkt_states ──
    if (item.bkt_update) {
      // ════════════════════════════════════════════════════════
      // PATH A (legacy): frontend sent pre-computed bkt_update
      // Store with M-1 FIX increment logic — no BKT computation
      // ════════════════════════════════════════════════════════
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
    } else if (item.subtopic_id) {
      // ════════════════════════════════════════════════════════
      // PATH B (new): no bkt_update but subtopic_id present
      // Compute BKT v4 server-side using lib/bkt-v4.ts
      // ════════════════════════════════════════════════════════
      try {
        const fsrsGrade = mapToFsrsGrade(item.grade);
        const isCorrect = fsrsGrade >= THRESHOLDS.BKT_CORRECT_MIN_GRADE;
        const instrumentType =
          item.instrument_type === "quiz" ? "quiz" as const : "flashcard" as const;

        // 1. Read existing BKT state
        const { data: existingBkt } = await db
          .from("bkt_states")
          .select("p_know, max_p_know, total_attempts, correct_attempts, p_transit, p_slip, p_guess")
          .eq("student_id", user.id)
          .eq("subtopic_id", item.subtopic_id)
          .maybeSingle();

        const currentMastery = existingBkt?.p_know ?? 0;
        const maxReachedMastery = existingBkt?.max_p_know ?? 0;
        const existingTotal = existingBkt?.total_attempts ?? 0;
        const existingCorrect = existingBkt?.correct_attempts ?? 0;

        // 2. Compute BKT v4 update
        const bktResult = computeBktV4Update({
          currentMastery,
          maxReachedMastery,
          isCorrect,
          instrumentType,
        });

        // 3. Increment counters (M-1 FIX)
        const finalTotalAttempts = existingTotal + 1;
        const finalCorrectAttempts = existingCorrect + (isCorrect ? 1 : 0);

        // 4. UPSERT with computed values
        const bktRow = {
          student_id: user.id,
          subtopic_id: item.subtopic_id,
          p_know: bktResult.p_know,
          max_p_know: bktResult.max_p_know,
          p_transit: existingBkt?.p_transit ?? 0.18,
          p_slip: existingBkt?.p_slip ?? 0.10,
          p_guess: existingBkt?.p_guess ?? 0.25,
          delta: bktResult.delta,
          total_attempts: finalTotalAttempts,
          correct_attempts: finalCorrectAttempts,
          last_attempt_at: nowIso,
        };

        const { error: bktErr } = await atomicUpsert(
          db,
          "bkt_states",
          "student_id,subtopic_id",
          bktRow,
        );

        if (bktErr) {
          errors.push({ index: i, step: "bkt_pathb", message: bktErr.message });
        } else {
          bktUpdated++;
        }
      } catch (e) {
        errors.push({ index: i, step: "bkt_pathb", message: (e as Error).message });
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
