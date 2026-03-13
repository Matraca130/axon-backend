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
 *     → Server returns computed values in `results` array (v4.5)
 *
 *   Detection: if item has fsrs_update → PATH A; else → PATH B
 *             if item has bkt_update → PATH A; else if subtopic_id → PATH B
 *
 * v4.2 ADDITIONS:
 *   - Leech detection: tracks consecutive_lapses on fsrs_states
 *   - is_leech flag when consecutive_lapses >= leech_threshold
 *
 * PR #104: Extracted validators/types to batch-review-validators.ts
 *
 * GAMIFICATION (PR #99): xpHookForBatchReviews awards per-review XP
 *   fire-and-forget after successful batch processing.
 */

import { Hono } from "npm:hono";
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import { atomicUpsert } from "./progress.ts";
import type { Context } from "npm:hono";

// ── PATH B imports: server-side FSRS + BKT compute ──────────
import { computeFsrsV4Update } from "../../lib/fsrs-v4.ts";
import { computeBktV4Update } from "../../lib/bkt-v4.ts";
import { THRESHOLDS } from "../../lib/types.ts";
import type { FsrsCardState } from "../../lib/types.ts";

// ── Gamification: batch XP hook ──────────────────────────
import { xpHookForBatchReviews } from "../../xp-hooks.ts";

// ── PR #104: Extracted validators ─────────────────────────
import type { ReviewItem, ComputedResult } from "./batch-review-validators.ts";
import {
  MAX_BATCH_SIZE,
  DEFAULT_LEECH_THRESHOLD,
  mapToFsrsGrade,
  validateReviewItem,
} from "./batch-review-validators.ts";

export const batchReviewRoutes = new Hono();

// ─── Session Ownership (same logic as reviews.ts) ───────────────

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
  return null;
}

// ─── Leech Threshold Loader ─────────────────────────────────

async function loadLeechThreshold(
  db: SupabaseClient,
  _userId: string,
): Promise<number> {
  try {
    const { data: globalData } = await db
      .from("algorithm_config")
      .select("leech_threshold")
      .is("institution_id", null)
      .maybeSingle();

    return globalData?.leech_threshold ?? DEFAULT_LEECH_THRESHOLD;
  } catch {
    return DEFAULT_LEECH_THRESHOLD;
  }
}

// ─── POST /review-batch ───────────────────────────────────────

batchReviewRoutes.post(`${PREFIX}/review-batch`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  if (!isUuid(body.session_id)) {
    return err(c, "session_id must be a valid UUID", 400);
  }
  const sessionId = body.session_id as string;

  if (!Array.isArray(body.reviews)) {
    return err(c, "reviews must be an array", 400);
  }
  if (body.reviews.length === 0) {
    return err(c, "reviews array must not be empty", 400);
  }
  if (body.reviews.length > MAX_BATCH_SIZE) {
    return err(c, `reviews array exceeds max batch size of ${MAX_BATCH_SIZE}`, 400);
  }

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

  const ownershipErr = await verifySessionOwnership(db, sessionId, user.id);
  if (ownershipErr) {
    return err(c, ownershipErr, 404);
  }

  const leechThreshold = await loadLeechThreshold(db, user.id);

  let reviewsCreated = 0;
  let fsrsUpdated = 0;
  let bktUpdated = 0;
  const errors: { index: number; step: string; message: string }[] = [];
  const computedResults: ComputedResult[] = [];
  const successfulReviews: Array<{ item_id: string; grade: number; instrument_type: string }> = [];

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
        successfulReviews.push({
          item_id: item.item_id,
          grade: item.grade,
          instrument_type: item.instrument_type,
        });
      }
    } catch (e) {
      errors.push({ index: i, step: "review", message: (e as Error).message });
    }

    // ── Step B: UPSERT fsrs_states ──
    if (item.fsrs_update) {
      // ════════ PATH A (legacy) ════════
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
          db, "fsrs_states", "student_id,flashcard_id", fsrsRow,
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
      // ════════ PATH B (server-side FSRS v4 Petrick) ════════
      try {
        const { data: existingFsrs } = await db
          .from("fsrs_states")
          .select("stability, difficulty, reps, lapses, state, last_review_at, consecutive_lapses, is_leech")
          .eq("student_id", user.id)
          .eq("flashcard_id", item.item_id)
          .maybeSingle();

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

        const prevConsecutiveLapses = existingFsrs?.consecutive_lapses ?? 0;
        let newConsecutiveLapses: number;
        if (fsrsGrade === 1) {
          newConsecutiveLapses = prevConsecutiveLapses + 1;
        } else {
          newConsecutiveLapses = 0;
        }
        const newIsLeech = newConsecutiveLapses >= leechThreshold;

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
          consecutive_lapses: newConsecutiveLapses,
          is_leech: newIsLeech,
        };

        const { error: fsrsErr } = await atomicUpsert(
          db, "fsrs_states", "student_id,flashcard_id", fsrsRow,
        );

        if (fsrsErr) {
          errors.push({ index: i, step: "fsrs_pathb", message: fsrsErr.message });
        } else {
          fsrsUpdated++;
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
        }
      } catch (e) {
        errors.push({ index: i, step: "fsrs_pathb", message: (e as Error).message });
      }
    }

    // ── Step C: READ + INCREMENT + UPSERT bkt_states ──
    if (item.bkt_update) {
      // ════════ PATH A (legacy) ════════
      try {
        const bkt = item.bkt_update;
        let finalTotalAttempts = bkt.total_attempts;
        let finalCorrectAttempts = bkt.correct_attempts;

        const { data: existing } = await db
          .from("bkt_states")
          .select("total_attempts, correct_attempts")
          .eq("student_id", user.id)
          .eq("subtopic_id", bkt.subtopic_id)
          .maybeSingle();

        if (existing) {
          finalTotalAttempts = (existing.total_attempts || 0) + bkt.total_attempts;
          finalCorrectAttempts = (existing.correct_attempts || 0) + bkt.correct_attempts;
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
          db, "bkt_states", "student_id,subtopic_id", bktRow,
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
      // ════════ PATH B (server-side BKT v4 Recovery) ════════
      try {
        const fsrsGrade = mapToFsrsGrade(item.grade);
        const isCorrect = fsrsGrade >= THRESHOLDS.BKT_CORRECT_MIN_GRADE;
        const instrumentType =
          item.instrument_type === "quiz" ? "quiz" as const : "flashcard" as const;

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

        const bktResult = computeBktV4Update({
          currentMastery,
          maxReachedMastery,
          isCorrect,
          instrumentType,
        });

        const finalTotalAttempts = existingTotal + 1;
        const finalCorrectAttempts = existingCorrect + (isCorrect ? 1 : 0);

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
          db, "bkt_states", "student_id,subtopic_id", bktRow,
        );

        if (bktErr) {
          errors.push({ index: i, step: "bkt_pathb", message: bktErr.message });
        } else {
          bktUpdated++;

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
        }
      } catch (e) {
        errors.push({ index: i, step: "bkt_pathb", message: (e as Error).message });
      }
    }
  }

  // PR #99: Fire-and-forget XP for batch reviews (contract §4.3)
  if (successfulReviews.length > 0) {
    try {
      xpHookForBatchReviews(user.id, sessionId, successfulReviews);
    } catch (hookErr) {
      console.warn("[XP Hook] batch review setup error:", (hookErr as Error).message);
    }
  }

  return ok(c, {
    processed: validatedItems.length,
    reviews_created: reviewsCreated,
    fsrs_updated: fsrsUpdated,
    bkt_updated: bktUpdated,
    errors: errors.length > 0 ? errors : undefined,
    results: computedResults.length > 0 ? computedResults : undefined,
  });
});
