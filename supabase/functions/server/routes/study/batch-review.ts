/**
 * routes/study/batch-review.ts — Atomic batch review persistence
 *
 * Server-side compute (spec v4.2, plan v3.7 Fase 3):
 *
 *   Frontend sends only grade (+ optional subtopic_id)
 *     → Server computes FSRS v4 Petrick + BKT v4 Recovery using lib/
 *     → Server stores computed values
 *     → Server returns computed values in `results` array
 *
 * v4.2 ADDITIONS:
 *   - Leech detection: tracks consecutive_lapses on fsrs_states
 *   - is_leech flag when consecutive_lapses >= leech_threshold
 *   - Keyword BKT propagation warnings surfaced in response
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
import type { Context } from "npm:hono";

// ── Server-side FSRS + BKT compute ──────────────────────────
import { computeFsrsV4Update } from "../../lib/fsrs-v4.ts";
import { computeBktV4Update } from "../../lib/bkt-v4.ts";
import { THRESHOLDS, BKT_WEIGHTS } from "../../lib/types.ts";
import type { FsrsCardState } from "../../lib/types.ts";

// ── Gamification: batch XP hook ──────────────────────────────
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

    // FIX: Clamp leech_threshold to [1, 50] to prevent nonsensical values
    // (0 would mark every card as a leech, >50 would effectively disable detection).
    const raw = globalData?.leech_threshold ?? DEFAULT_LEECH_THRESHOLD;
    return Math.max(1, Math.min(50, raw));
  } catch {
    return DEFAULT_LEECH_THRESHOLD;
  }
}

// ─── Keyword BKT Propagation (spec §4.2) ─────────────────────
// After a flashcard/quiz review updates its subtopic's BKT state,
// propagate a weighted BKT update to ALL sibling subtopics under
// the same keyword. Fire-and-forget: errors are logged, not thrown.

async function propagateKeywordBkt(
  db: SupabaseClient,
  userId: string,
  itemId: string,
  instrumentType: string,
  isCorrect: boolean,
  sourceSubtopicId: string | undefined,
  precomputedKeywordId?: string,
): Promise<string | undefined> {
  try {
    // Input validation
    if (!["quiz", "flashcard"].includes(instrumentType)) {
      console.warn(`[KW-BKT] Invalid instrumentType: ${instrumentType}`);
      return `Invalid instrumentType: ${instrumentType}`;
    }

    let keywordId: string;
    if (precomputedKeywordId) {
      // Caller already resolved the keyword — skip the lookup entirely.
      keywordId = precomputedKeywordId;
    } else {
      // 1. Determine the source table based on instrument type
      const table = instrumentType === "quiz" ? "quiz_questions" : "flashcards";

      // 2. Look up the item's keyword_id
      const { data: item, error: itemErr } = await db
        .from(table)
        .select("keyword_id")
        .eq("id", itemId)
        .maybeSingle();

      if (itemErr || !item?.keyword_id) {
        if (itemErr) {
          console.error(`[KW-BKT] Failed to look up ${table} keyword_id:`, itemErr.message);
          return `Failed to look up keyword: ${itemErr.message}`;
        }
        return; // No keyword linked — nothing to propagate (not an error)
      }

      keywordId = item.keyword_id as string;
    }

    // 3. Find all subtopics under this keyword
    const { data: subtopics, error: subErr } = await db
      .from("subtopics")
      .select("id")
      .eq("keyword_id", keywordId)
      .is("deleted_at", null);

    if (subErr || !subtopics || subtopics.length === 0) {
      if (subErr) {
        console.error("[KW-BKT] Failed to look up subtopics:", subErr.message);
        return `Failed to look up subtopics: ${subErr.message}`;
      }
      return; // No subtopics — nothing to propagate
    }

    // 4. Determine the weight for this instrument type
    const weight = instrumentType === "quiz"
      ? BKT_WEIGHTS.quiz
      : BKT_WEIGHTS.flashcard;

    const nowIso = new Date().toISOString();

    // 5. Filter out source subtopic and collect IDs for batch fetch
    const targetSubtopics = subtopics.filter(s => s.id !== sourceSubtopicId);
    if (targetSubtopics.length === 0) return;

    const targetIds = targetSubtopics.map(s => s.id);

    // 6. BATCH fetch all existing BKT states in ONE query (fixes N+1)
    const { data: allBktStates, error: batchErr } = await db
      .from("bkt_states")
      .select("subtopic_id, p_know, max_p_know, total_attempts, correct_attempts, p_transit, p_slip, p_guess")
      .eq("student_id", userId)
      .in("subtopic_id", targetIds);

    if (batchErr) {
      console.error("[KW-BKT] Batch fetch failed:", batchErr.message);
      return `Batch fetch failed: ${batchErr.message}`;
    }

    // Create lookup map for O(1) access
    const bktMap = new Map(
      (allBktStates ?? []).map(s => [s.subtopic_id, s])
    );

    // 7. Compute weighted updates and build upsert batch
    const upsertRows = [];
    for (const sub of targetSubtopics) {
      const existing = bktMap.get(sub.id);
      const currentMastery = existing?.p_know ?? 0;
      const maxReachedMastery = existing?.max_p_know ?? 0;

      // Compute BKT update using the engine
      const bktResult = computeBktV4Update({
        currentMastery,
        maxReachedMastery,
        isCorrect,
        instrumentType: instrumentType === "quiz" ? "quiz" : "flashcard",
      });

      // Apply weight to the delta
      const weightedDelta = bktResult.delta * weight;
      const weightedPKnow = Math.max(0, Math.min(1, currentMastery + weightedDelta));
      const weightedMaxPKnow = Math.max(maxReachedMastery, weightedPKnow);

      upsertRows.push({
        student_id: userId,
        subtopic_id: sub.id,
        p_know: Math.round(weightedPKnow * 10000) / 10000,
        max_p_know: Math.round(weightedMaxPKnow * 10000) / 10000,
        p_transit: existing?.p_transit ?? 0.18,
        p_slip: existing?.p_slip ?? 0.10,
        p_guess: existing?.p_guess ?? 0.25,
        delta: Math.round(weightedDelta * 10000) / 10000,
        total_attempts: (existing?.total_attempts ?? 0) + 1,
        correct_attempts: (existing?.correct_attempts ?? 0) + (isCorrect ? 1 : 0),
        last_attempt_at: nowIso,
      });
    }

    // 8. BATCH upsert all rows in ONE query (fixes N+1 writes)
    if (upsertRows.length > 0) {
      const { error: upsertErr } = await db
        .from("bkt_states")
        .upsert(upsertRows, { onConflict: "student_id,subtopic_id" });

      if (upsertErr) {
        console.error(`[KW-BKT] Batch upsert failed (${upsertRows.length} rows):`, upsertErr.message);
        return `Batch upsert failed: ${upsertErr.message}`;
      }
    }

    // Success — no error to report
    return;
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[KW-BKT] Keyword propagation failed:", msg);
    return `Propagation error: ${msg}`;
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

  // ── Load leech threshold from algorithm_config ──
  const leechThreshold = await loadLeechThreshold(db, user.id);

  let reviewsCreated = 0;
  let fsrsUpdated = 0;
  let bktUpdated = 0;
  const errors: { index: number; step: string; message: string }[] = [];
  const computedResults: ComputedResult[] = [];

  // Keyword propagation warnings surfaced in response
  const propagationWarnings: string[] = [];
  const propagationPromises: Promise<void>[] = [];

  // Track successfully created reviews for XP hook
  const successfulReviews: Array<{ item_id: string; grade: number; instrument_type: string }> = [];

  // ── 2.4: Batch pre-load FSRS and BKT states ──────────────────
  const allFlashcardIds = validatedItems
    .filter(i => i.item_id)
    .map(i => i.item_id);
  const allBktSubtopicIds = [...new Set(
    validatedItems.filter(i => i.subtopic_id).map(i => i.subtopic_id as string)
  )];

  const { data: allFsrs } = allFlashcardIds.length > 0
    ? await db.from("fsrs_states")
        .select("flashcard_id, stability, difficulty, reps, lapses, state, last_review_at, consecutive_lapses, is_leech")
        .in("flashcard_id", allFlashcardIds)
        .eq("student_id", user.id)
    : { data: [] };
  const { data: allBkt } = allBktSubtopicIds.length > 0
    ? await db.from("bkt_states")
        .select("subtopic_id, p_know, max_p_know, total_attempts, correct_attempts, p_transit, p_slip, p_guess")
        .in("subtopic_id", allBktSubtopicIds)
        .eq("student_id", user.id)
    : { data: [] };

  const fsrsMap = new Map(allFsrs?.map(s => [s.flashcard_id, s]) ?? []);
  const bktMap = new Map(allBkt?.map(s => [s.subtopic_id, s]) ?? []);

  // ── Fix #3: Pre-fetch keyword_ids for every item_id, grouped by instrument ──
  // Previous code called propagateKeywordBkt once per review, which meant
  // 100 cards under the same keyword = 100 redundant propagations. We now
  // resolve the keyword upfront and dedupe by keyword_id at the end of the loop.
  const flashcardItemIds = validatedItems
    .filter(i => i.instrument_type === "flashcard")
    .map(i => i.item_id);
  const quizItemIds = validatedItems
    .filter(i => i.instrument_type === "quiz")
    .map(i => i.item_id);

  const itemKeywordMap = new Map<string, string>();
  if (flashcardItemIds.length > 0) {
    const { data: fcRows } = await db
      .from("flashcards")
      .select("id, keyword_id")
      .in("id", flashcardItemIds);
    for (const row of fcRows ?? []) {
      if (row.keyword_id) itemKeywordMap.set(row.id as string, row.keyword_id as string);
    }
  }
  if (quizItemIds.length > 0) {
    const { data: qzRows } = await db
      .from("quiz_questions")
      .select("id, keyword_id")
      .in("id", quizItemIds);
    for (const row of qzRows ?? []) {
      if (row.keyword_id) itemKeywordMap.set(row.id as string, row.keyword_id as string);
    }
  }

  // Accumulate one propagation per unique keyword. "Last write wins" for
  // isCorrect and source_subtopic: we only care that the propagation runs
  // exactly once per keyword using the most recent review's outcome.
  const propagationByKeyword = new Map<string, {
    itemId: string;
    instrumentType: string;
    isCorrect: boolean;
    sourceSubtopicId?: string;
  }>();

  // ════════════════════════════════════════════════════════════
  // FIX #1 — COMPUTE PHASE (pure TS, no DB writes)
  // ════════════════════════════════════════════════════════════
  // Previously this loop issued DB writes per review. If a later
  // FSRS/BKT write failed after the `reviews` row was already
  // inserted, the batch ended in an inconsistent state (a review
  // row with no FSRS update, or vice-versa). We now run the entire
  // batch as a single transaction via `process_review_batch` RPC:
  // this loop only computes, and the RPC does all writes atomically.

  interface ReviewRowPayload {
    item_id: string;
    instrument_type: string;
    grade: number;
    response_time_ms?: number;
  }
  interface FsrsRowPayload {
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
  interface BktRowPayload {
    student_id: string;
    subtopic_id: string;
    p_know: number;
    max_p_know: number;
    p_transit: number;
    p_slip: number;
    p_guess: number;
    delta: number;
    total_delta: number;    // +1 per review, added to existing counter in RPC
    correct_delta: number;  // 0 or 1, added to existing counter in RPC
    last_attempt_at: string;
  }

  const reviewRows: ReviewRowPayload[] = [];
  const fsrsRows: FsrsRowPayload[] = [];
  const bktRows: BktRowPayload[] = [];

  for (let i = 0; i < validatedItems.length; i++) {
    const item = validatedItems[i];
    const now = new Date();
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

    // Track for XP hook (fires post-commit, same as before).
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
          student_id: user.id,
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

  // ════════════════════════════════════════════════════════════
  // PERSIST PHASE — one atomic RPC call
  // ════════════════════════════════════════════════════════════
  // The RPC wraps: INSERT reviews + UPSERT fsrs_states + UPSERT
  // bkt_states (with inline counter arithmetic) in a single
  // PL/pgSQL function, which runs as a single transaction.
  // A failure here rolls the whole batch back — no partial writes.
  try {
    const { data: rpcData, error: rpcErr } = await db.rpc("process_review_batch", {
      p_session_id: sessionId,
      p_reviews: reviewRows,
      p_fsrs: fsrsRows,
      p_bkt: bktRows,
    });

    if (rpcErr) {
      // Transaction rolled back — nothing was persisted.
      return c.json({
        error: `Atomic batch persistence failed: ${rpcErr.message}`,
        processed: validatedItems.length,
        reviews_created: 0,
        fsrs_updated: 0,
        bkt_updated: 0,
      }, 500);
    }

    // RPC returns a single-row TABLE; supabase-js surfaces it as an array.
    const stats = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    reviewsCreated = stats?.reviews_created ?? reviewRows.length;
    fsrsUpdated = stats?.fsrs_updated ?? fsrsRows.length;
    bktUpdated = stats?.bkt_updated ?? bktRows.length;
  } catch (e) {
    return c.json({
      error: `Atomic batch persistence threw: ${(e as Error).message}`,
      processed: validatedItems.length,
      reviews_created: 0,
      fsrs_updated: 0,
      bkt_updated: 0,
    }, 500);
  }

  // PR #99: Fire-and-forget XP for batch reviews (contract §4.3)
  // Only fires if at least 1 review was successfully created.
  if (successfulReviews.length > 0) {
    try {
      xpHookForBatchReviews(user.id, sessionId, successfulReviews);
    } catch (hookErr) {
      console.error("[XP Hook] batch review setup error:", (hookErr as Error).message);
    }
  }

  // Fix #3: Fire one propagation per unique keyword (not per review).
  for (const [keywordId, payload] of propagationByKeyword) {
    propagationPromises.push(
      propagateKeywordBkt(
        db,
        user.id,
        payload.itemId,
        payload.instrumentType,
        payload.isCorrect,
        payload.sourceSubtopicId,
        keywordId,
      )
        .then(warning => { if (warning) propagationWarnings.push(warning); })
        .catch((e) => { propagationWarnings.push((e as Error).message); }),
    );
  }

  // Wait for all keyword propagations to settle before responding,
  // so propagation_warnings are populated in the response.
  if (propagationPromises.length > 0) {
    await Promise.allSettled(propagationPromises);
  }

  // ── Response status selection ─────────────────────────────
  // If every item failed → 500 (batch is a total failure).
  // If some items succeeded and some failed → 207 Multi-Status.
  // Otherwise → 200 OK.
  // `reviewsCreated === 0` is the strongest "nothing persisted" signal because
  // without a review row, downstream FSRS/BKT upserts are semantically orphan.
  const hasPartialFailure = errors.length > 0 && reviewsCreated > 0;
  const totalFailure = errors.length > 0 && reviewsCreated === 0;

  const responseBody = {
    processed: validatedItems.length,
    reviews_created: reviewsCreated,
    fsrs_updated: fsrsUpdated,
    bkt_updated: bktUpdated,
    errors: errors.length > 0 ? errors : undefined,
    results: computedResults.length > 0 ? computedResults : undefined,
    propagation_warnings: propagationWarnings.length > 0 ? propagationWarnings : undefined,
  };

  if (totalFailure) {
    // Use c.json directly: err() only accepts a plain string message,
    // but the client needs the structured error array for retry logic.
    return c.json({ error: "All reviews in batch failed", ...responseBody }, 500);
  }
  if (hasPartialFailure) {
    return ok(c, responseBody, 207);
  }
  return ok(c, responseBody);
});
