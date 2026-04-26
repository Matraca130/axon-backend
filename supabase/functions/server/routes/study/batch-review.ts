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
  selectBatchResponseStatus,
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

/**
 * Loads the global leech threshold from algorithm_config.
 *
 * DB errors still fall back to DEFAULT_LEECH_THRESHOLD (batch review
 * should not fail because the tuning table is unreachable), but now
 * the fallback is logged so operators can see when the threshold has
 * drifted from configuration.
 */
async function loadLeechThreshold(db: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await db
      .from("algorithm_config")
      .select("leech_threshold")
      .is("institution_id", null)
      .maybeSingle();

    if (error) {
      console.warn(
        `[batch-review] loadLeechThreshold DB error, falling back to DEFAULT_LEECH_THRESHOLD: ${error.message}`,
      );
      return DEFAULT_LEECH_THRESHOLD;
    }

    // Clamp to [1, 50] to prevent nonsensical values: 0 would mark
    // every card as a leech, >50 would effectively disable detection.
    const raw = data?.leech_threshold ?? DEFAULT_LEECH_THRESHOLD;
    return Math.max(1, Math.min(50, raw));
  } catch (e) {
    console.warn(
      `[batch-review] loadLeechThreshold threw, falling back to DEFAULT_LEECH_THRESHOLD:`,
      e,
    );
    return DEFAULT_LEECH_THRESHOLD;
  }
}

export interface StateMaps {
  fsrsMap: Map<string, FsrsStateRow>;
  bktMap: Map<string, BktStateRow>;
  itemKeywordMap: Map<string, string>;
}

export interface StateMapsResult {
  data: StateMaps | null;
  error: string | null;
}

export async function preloadStateMaps(
  db: SupabaseClient,
  userId: string,
  items: ReviewItem[],
): Promise<StateMapsResult> {
  const allFlashcardIds = items.filter(i => i.item_id).map(i => i.item_id);
  const allBktSubtopicIds = [...new Set(
    items.filter(i => i.subtopic_id).map(i => i.subtopic_id as string),
  )];

  const flashcardItemIds = items.filter(i => i.instrument_type === "flashcard").map(i => i.item_id);
  const quizItemIds = items.filter(i => i.instrument_type === "quiz").map(i => i.item_id);

  // All four DB reads are independent — run them in parallel. Pre-refactor
  // was serial for no reason, adding ~4 round-trips of latency per batch.
  const [fsrsRes, bktRes, fcKwRes, qKwRes] = await Promise.all([
    allFlashcardIds.length > 0
      ? db.from("fsrs_states")
          .select("flashcard_id, stability, difficulty, reps, lapses, state, last_review_at, consecutive_lapses, is_leech")
          .in("flashcard_id", allFlashcardIds)
          .eq("student_id", userId)
      : Promise.resolve({ data: [] as FsrsStateRow[], error: null }),
    allBktSubtopicIds.length > 0
      ? db.from("bkt_states")
          .select("subtopic_id, p_know, max_p_know, total_attempts, correct_attempts, p_transit, p_slip, p_guess")
          .in("subtopic_id", allBktSubtopicIds)
          .eq("student_id", userId)
      : Promise.resolve({ data: [] as BktStateRow[], error: null }),
    flashcardItemIds.length > 0
      ? db.from("flashcards").select("id, keyword_id").in("id", flashcardItemIds)
      : Promise.resolve({ data: [] as Array<{ id: string; keyword_id: string | null }>, error: null }),
    quizItemIds.length > 0
      ? db.from("quiz_questions").select("id, keyword_id").in("id", quizItemIds)
      : Promise.resolve({ data: [] as Array<{ id: string; keyword_id: string | null }>, error: null }),
  ]);

  // Surface any DB error: a silent empty-Map fallback would make the
  // compute loop treat cards as fresh, corrupting FSRS/BKT state on write.
  const checks: Array<[string, { error: unknown }]> = [
    ["fsrs_states", fsrsRes],
    ["bkt_states", bktRes],
    ["flashcards", fcKwRes],
    ["quiz_questions", qKwRes],
  ];
  for (const [table, res] of checks) {
    const e = res.error as { message?: string } | null | undefined;
    if (e) {
      console.error(`[batch-review] preload ${table} failed:`, e.message ?? "unknown error");
      return { data: null, error: `Preload ${table} failed` };
    }
  }

  const { data: allFsrs } = fsrsRes;
  const { data: allBkt } = bktRes;
  const { data: flashcardsKw } = fcKwRes;
  const { data: quizKw } = qKwRes;

  const fsrsMap = new Map<string, FsrsStateRow>(
    allFsrs?.map(s => [s.flashcard_id as string, s as FsrsStateRow]) ?? [],
  );
  const bktMap = new Map<string, BktStateRow>(
    allBkt?.map(s => [s.subtopic_id as string, s as BktStateRow]) ?? [],
  );
  const itemKeywordMap = new Map<string, string>();
  for (const row of flashcardsKw ?? []) {
    if (row.keyword_id) itemKeywordMap.set(row.id as string, row.keyword_id as string);
  }
  for (const row of quizKw ?? []) {
    if (row.keyword_id) itemKeywordMap.set(row.id as string, row.keyword_id as string);
  }

  return { data: { fsrsMap, bktMap, itemKeywordMap }, error: null };
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
      console.error(
        `[batch-review] process_review_batch RPC failed: ${error.message}`,
      );
      return {
        ok: false,
        reviewsCreated: 0,
        fsrsUpdated: 0,
        bktUpdated: 0,
        error: "Atomic batch persistence failed",
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
    console.error(`[batch-review] process_review_batch threw:`, e);
    return {
      ok: false,
      reviewsCreated: 0,
      fsrsUpdated: 0,
      bktUpdated: 0,
      error: "Atomic batch persistence threw",
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
  const preloaded = await preloadStateMaps(db, user.id, validatedItems);
  if (preloaded.error || !preloaded.data) {
    return c.json({
      error: preloaded.error ?? "Preload failed",
      processed: validatedItems.length,
      reviews_created: 0,
      fsrs_updated: 0,
      bkt_updated: 0,
    }, 500);
  }
  const { fsrsMap, bktMap, itemKeywordMap } = preloaded.data;

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

  // ── 9. Response status selection (pure) ──────────────────
  // Tri-state logic extracted to selectBatchResponseStatus for unit
  // testability. The handler only adapts the returned {status, body}
  // into Hono responses; the status-decision logic has no Hono coupling.
  const { status, body: responseBody } = selectBatchResponseStatus({
    processed: validatedItems.length,
    errors: computed.errors,
    computedResults: computed.computedResults,
    persist: {
      reviewsCreated: persist.reviewsCreated,
      fsrsUpdated: persist.fsrsUpdated,
      bktUpdated: persist.bktUpdated,
    },
    propagationWarnings,
  });

  if (status === 500) {
    // Use c.json directly: err() only accepts a plain string message,
    // but the client needs the structured error array for retry logic.
    return c.json(responseBody, 500);
  }
  if (status === 207) {
    return ok(c, responseBody, 207);
  }
  return ok(c, responseBody);
});
