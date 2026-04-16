/**
 * routes/study/batch-review.ts — Atomic batch review persistence (orchestrator)
 *
 * Server-side compute (spec v4.2, plan v3.7 Fase 3):
 *
 *   Frontend sends only grade (+ optional subtopic_id)
 *     → Server computes FSRS v4 Petrick + BKT v4 Recovery using lib/
 *     → Server stores computed values via `process_review_batch` RPC
 *     → Server returns computed values in `results` array
 *
 * Layering after the 2026-04 split:
 *
 *   batch-review.ts (this file)          → orchestrator + HTTP boundary
 *   batch-review-compute.ts              → pure FSRS/BKT compute + dedupe
 *   batch-review-propagation.ts          → keyword BKT propagation
 *   batch-review-validators.ts           → body/item validation (pre-existing)
 *   session-ownership.ts                 → shared ownership check
 *
 * This file only contains I/O, error-response mapping, and orchestration
 * — no algorithmic logic. For the per-item compute, see
 * `batch-review-compute.ts`; for keyword propagation, see
 * `batch-review-propagation.ts`.
 *
 * GAMIFICATION (PR #99): xpHookForBatchReviews awards per-review XP
 *   fire-and-forget after successful batch processing.
 */

import { Hono } from "npm:hono";
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import type { Context } from "npm:hono";

import { xpHookForBatchReviews } from "../../xp-hooks.ts";

import type { ReviewItem } from "./batch-review-validators.ts";
import {
  MAX_BATCH_SIZE,
  DEFAULT_LEECH_THRESHOLD,
  validateReviewItem,
} from "./batch-review-validators.ts";

import { verifySessionOwnership } from "./session-ownership.ts";
import { propagateKeywordBkt } from "./batch-review-propagation.ts";

import {
  computeReviewBatch,
  dedupePayloads,
} from "./batch-review-compute.ts";
import type {
  FsrsStateRow,
  BktStateRow,
  FsrsRowPayload,
  BktRowPayload,
  ReviewRowPayload,
  PropagationIntent,
} from "./batch-review-compute.ts";

export const batchReviewRoutes = new Hono();

// ═══════════════════════════════════════════════════════════════
// Helpers — DB-touching, scoped to this handler
// ═══════════════════════════════════════════════════════════════

async function loadLeechThreshold(db: SupabaseClient): Promise<number> {
  try {
    const { data } = await db
      .from("algorithm_config")
      .select("leech_threshold")
      .is("institution_id", null)
      .maybeSingle();

    // Clamp to [1, 50] to prevent nonsensical values: 0 would mark
    // every card as a leech, >50 would effectively disable detection.
    const raw = data?.leech_threshold ?? DEFAULT_LEECH_THRESHOLD;
    return Math.max(1, Math.min(50, raw));
  } catch {
    return DEFAULT_LEECH_THRESHOLD;
  }
}

interface StateMaps {
  fsrsMap: Map<string, FsrsStateRow>;
  bktMap: Map<string, BktStateRow>;
  itemKeywordMap: Map<string, string>;
}

async function preloadStateMaps(
  db: SupabaseClient,
  userId: string,
  items: ReviewItem[],
): Promise<StateMaps> {
  const allFlashcardIds = items.filter(i => i.item_id).map(i => i.item_id);
  const allBktSubtopicIds = [...new Set(
    items.filter(i => i.subtopic_id).map(i => i.subtopic_id as string),
  )];

  const { data: allFsrs } = allFlashcardIds.length > 0
    ? await db.from("fsrs_states")
        .select("flashcard_id, stability, difficulty, reps, lapses, state, last_review_at, consecutive_lapses, is_leech")
        .in("flashcard_id", allFlashcardIds)
        .eq("student_id", userId)
    : { data: [] };
  const { data: allBkt } = allBktSubtopicIds.length > 0
    ? await db.from("bkt_states")
        .select("subtopic_id, p_know, max_p_know, total_attempts, correct_attempts, p_transit, p_slip, p_guess")
        .in("subtopic_id", allBktSubtopicIds)
        .eq("student_id", userId)
    : { data: [] };

  const fsrsMap = new Map<string, FsrsStateRow>(
    allFsrs?.map(s => [s.flashcard_id as string, s as FsrsStateRow]) ?? [],
  );
  const bktMap = new Map<string, BktStateRow>(
    allBkt?.map(s => [s.subtopic_id as string, s as BktStateRow]) ?? [],
  );

  // Pre-resolve keyword_id per item so the compute loop can build the
  // propagation-by-keyword map without extra DB round-trips. Grouped
  // by instrument table — only one IN(...) query per table.
  const flashcardItemIds = items.filter(i => i.instrument_type === "flashcard").map(i => i.item_id);
  const quizItemIds = items.filter(i => i.instrument_type === "quiz").map(i => i.item_id);
  const itemKeywordMap = new Map<string, string>();

  if (flashcardItemIds.length > 0) {
    const { data } = await db.from("flashcards").select("id, keyword_id").in("id", flashcardItemIds);
    for (const row of data ?? []) {
      if (row.keyword_id) itemKeywordMap.set(row.id as string, row.keyword_id as string);
    }
  }
  if (quizItemIds.length > 0) {
    const { data } = await db.from("quiz_questions").select("id, keyword_id").in("id", quizItemIds);
    for (const row of data ?? []) {
      if (row.keyword_id) itemKeywordMap.set(row.id as string, row.keyword_id as string);
    }
  }

  return { fsrsMap, bktMap, itemKeywordMap };
}

interface PersistResult {
  ok: boolean;
  reviewsCreated: number;
  fsrsUpdated: number;
  bktUpdated: number;
  error?: string;
}

async function persistBatch(
  db: SupabaseClient,
  sessionId: string,
  reviewRows: ReviewRowPayload[],
  dedupedFsrsRows: FsrsRowPayload[],
  dedupedBktRows: BktRowPayload[],
): Promise<PersistResult> {
  // `process_review_batch` wraps INSERT reviews + UPSERT fsrs_states +
  // UPSERT bkt_states (with inline counter arithmetic) in a single
  // PL/pgSQL transaction. A failure here rolls the whole batch back —
  // no partial writes.
  try {
    const { data, error } = await db.rpc("process_review_batch", {
      p_session_id: sessionId,
      p_reviews: reviewRows,
      p_fsrs: dedupedFsrsRows,
      p_bkt: dedupedBktRows,
    });

    if (error) {
      return {
        ok: false,
        reviewsCreated: 0,
        fsrsUpdated: 0,
        bktUpdated: 0,
        error: `Atomic batch persistence failed: ${error.message}`,
      };
    }

    // RPC returns a single-row TABLE; supabase-js surfaces it as an array.
    const stats = Array.isArray(data) ? data[0] : data;
    return {
      ok: true,
      reviewsCreated: stats?.reviews_created ?? reviewRows.length,
      fsrsUpdated: stats?.fsrs_updated ?? dedupedFsrsRows.length,
      bktUpdated: stats?.bkt_updated ?? dedupedBktRows.length,
    };
  } catch (e) {
    return {
      ok: false,
      reviewsCreated: 0,
      fsrsUpdated: 0,
      bktUpdated: 0,
      error: `Atomic batch persistence threw: ${(e as Error).message}`,
    };
  }
}

async function runPropagations(
  db: SupabaseClient,
  userId: string,
  propagationByKeyword: Map<string, PropagationIntent>,
): Promise<string[]> {
  const warnings: string[] = [];
  const promises: Promise<void>[] = [];

  for (const [keywordId, payload] of propagationByKeyword) {
    promises.push(
      propagateKeywordBkt(
        db,
        userId,
        payload.itemId,
        payload.instrumentType,
        payload.isCorrect,
        payload.sourceSubtopicId,
        keywordId,
      )
        .then(warning => { if (warning) warnings.push(warning); })
        .catch((e) => { warnings.push((e as Error).message); }),
    );
  }

  if (promises.length > 0) {
    await Promise.allSettled(promises);
  }
  return warnings;
}

// ═══════════════════════════════════════════════════════════════
// POST /review-batch
// ═══════════════════════════════════════════════════════════════

batchReviewRoutes.post(`${PREFIX}/review-batch`, async (c: Context) => {
  // ── 1. Auth ───────────────────────────────────────────────
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── 2. Parse + validate body ──────────────────────────────
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
    if (result.error) return err(c, result.error, 400);
    validatedItems.push(result.valid);
  }

  // ── 3. Ownership ─────────────────────────────────────────
  // Preserve pre-refactor behavior: batch-review returned 404 for both
  // "not found" and "lookup failed". Leave as-is so the contract is
  // unchanged; a future PR can differentiate if desired.
  const ownership = await verifySessionOwnership(db, sessionId, user.id);
  if (!ownership.ok) {
    return err(c, ownership.message, 404);
  }

  // ── 4. Pre-load state + leech threshold ──────────────────
  const leechThreshold = await loadLeechThreshold(db);
  const { fsrsMap, bktMap, itemKeywordMap } = await preloadStateMaps(db, user.id, validatedItems);

  // ── 5. Pure compute + dedupe ─────────────────────────────
  const computed = computeReviewBatch({
    validatedItems,
    userId: user.id,
    leechThreshold,
    fsrsMap,
    bktMap,
    itemKeywordMap,
  });

  const { dedupedFsrsRows, dedupedBktRows } = dedupePayloads({
    fsrsRows: computed.fsrsRows,
    bktRows: computed.bktRows,
  });

  // ── 6. Atomic RPC persist ────────────────────────────────
  const persist = await persistBatch(
    db, sessionId, computed.reviewRows, dedupedFsrsRows, dedupedBktRows,
  );
  if (!persist.ok) {
    return c.json({
      error: persist.error,
      processed: validatedItems.length,
      reviews_created: 0,
      fsrs_updated: 0,
      bkt_updated: 0,
    }, 500);
  }

  // ── 7. Fire-and-forget XP hook ───────────────────────────
  // PR #99: xpHookForBatchReviews awards per-review XP after successful
  // batch processing. Only fires if at least 1 review was queued.
  if (computed.successfulReviews.length > 0) {
    try {
      xpHookForBatchReviews(user.id, sessionId, computed.successfulReviews);
    } catch (hookErr) {
      console.error("[XP Hook] batch review setup error:", (hookErr as Error).message);
    }
  }

  // ── 8. Keyword propagation (await so warnings appear in response) ─
  const propagationWarnings = await runPropagations(db, user.id, computed.propagationByKeyword);

  // ── 9. Response status selection ─────────────────────────
  // If every item failed → 500 (batch is a total failure).
  // If some items succeeded and some failed → 207 Multi-Status.
  // Otherwise → 200 OK.
  // `reviewsCreated === 0` is the strongest "nothing persisted" signal
  // because without a review row, downstream FSRS/BKT upserts are
  // semantically orphan.
  const hasPartialFailure = computed.errors.length > 0 && persist.reviewsCreated > 0;
  const totalFailure = computed.errors.length > 0 && persist.reviewsCreated === 0;

  const responseBody = {
    processed: validatedItems.length,
    reviews_created: persist.reviewsCreated,
    fsrs_updated: persist.fsrsUpdated,
    bkt_updated: persist.bktUpdated,
    errors: computed.errors.length > 0 ? computed.errors : undefined,
    results: computed.computedResults.length > 0 ? computed.computedResults : undefined,
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
