/**
 * routes-study-queue.tsx — Study Queue (Algorithmic Priority Queue) for Axon v4.4
 *
 * GET /study-queue — Returns a prioritized list of flashcards to study.
 *
 * The algorithm combines three systems:
 *   1. BKT (Bayesian Knowledge Tracing) — concept-level mastery per subtopic
 *      Source: bkt_states table (p_know, total_attempts, lapses, etc.)
 *
 *   2. FSRS (Free Spaced Repetition Scheduler) — card-level scheduling
 *      Source: fsrs_states table (stability, difficulty, due_at, state, lapses, reps)
 *
 *   3. NeedScore — weighted urgency score per card combining:
 *      - Overdue factor (0.40): how far past due_at
 *      - Mastery factor (0.30): inverse of BKT p_know for the subtopic
 *      - Fragility factor (0.20): lapses / (reps + 1) from FSRS
 *      - Novelty factor (0.10): new/unseen cards get a boost
 *
 * Query params:
 *   ?course_id=xxx    — optional, filter flashcards to a specific course
 *   ?limit=20         — optional, max items to return (default 20, max 100)
 *   ?include_future=0 — optional, if "1" include cards not yet due
 *
 * Response:
 *   { data: { queue: StudyQueueItem[], meta: { ... } } }
 *
 * M-1 Performance fix:
 *   Steps 1-3 (BKT, FSRS, flashcards) now run in parallel via Promise.all.
 *   Step 4 (course→summaries filter) uses get_course_summary_ids() DB function
 *   (single 4-table JOIN) with graceful fallback to sequential queries.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "./db.ts";
import { isUuid } from "./validate.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js";

export const studyQueueRoutes = new Hono();

// ─── NeedScore Configuration (v4.2) ──────────────────────────────────

const NEED_CONFIG = {
  overdueWeight: 0.40,
  masteryWeight: 0.30,
  fragilityWeight: 0.20,
  noveltyWeight: 0.10,
  graceDays: 1,
};

// ─── NeedScore Calculation ────────────────────────────────────────────

interface NeedScoreInput {
  dueAt: string | null;
  fsrsLapses: number;
  fsrsReps: number;
  fsrsState: string;
  fsrsStability: number;
  pKnow: number;
}

function calculateNeedScore(input: NeedScoreInput, now: Date): number {
  const { dueAt, fsrsLapses, fsrsReps, fsrsState, pKnow } = input;

  // Factor 1: Overdue (exponential, capped at 1.0)
  let overdue = 0;
  if (!dueAt) {
    overdue = 1.0;
  } else {
    const dueDate = new Date(dueAt);
    const daysOverdue =
      (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOverdue > 0) {
      overdue = 1 - Math.exp(-daysOverdue / NEED_CONFIG.graceDays);
    }
  }

  // Factor 2: Mastery need (inverse of BKT p_know)
  const needMastery = 1 - pKnow;

  // Factor 3: Fragility (lapses relative to total practice)
  const needFragility = Math.min(
    1,
    fsrsLapses / Math.max(1, fsrsReps + fsrsLapses + 1),
  );

  // Factor 4: Novelty (boost for new/unseen cards)
  const needNovelty = fsrsState === "new" ? 1.0 : 0.0;

  const score =
    NEED_CONFIG.overdueWeight * overdue +
    NEED_CONFIG.masteryWeight * needMastery +
    NEED_CONFIG.fragilityWeight * needFragility +
    NEED_CONFIG.noveltyWeight * needNovelty;

  return Math.max(0, Math.min(1, score));
}

// ─── Retention Calculation (forgetting curve) ─────────────────────────

function calculateRetention(
  lastReviewAt: string | null,
  stabilityDays: number,
  now: Date,
): number {
  if (!lastReviewAt || stabilityDays <= 0) return 0;
  const daysSince =
    (now.getTime() - new Date(lastReviewAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.min(1, Math.exp(-daysSince / stabilityDays)));
}

// ─── Mastery Color (with hysteresis thresholds) ───────────────────────

function getMasteryColor(pKnow: number): "green" | "yellow" | "red" | "gray" {
  if (pKnow < 0) return "gray";
  if (pKnow >= 0.80) return "green";
  if (pKnow >= 0.50) return "yellow";
  return "red";
}

// ─── Course → Summary IDs resolution ──────────────────────────────────

/**
 * Resolve course_id to a Set of summary IDs.
 * Primary: RPC call to get_course_summary_ids() — single 4-table JOIN.
 * Fallback: 4 sequential queries if the DB function doesn't exist yet.
 */
async function resolveSummaryIdsForCourse(
  db: SupabaseClient,
  courseId: string,
): Promise<Set<string> | null> {
  // ── Primary: single RPC call ──
  const { data: rpcData, error: rpcError } = await db.rpc(
    "get_course_summary_ids",
    { p_course_id: courseId },
  );

  if (!rpcError && rpcData) {
    if (rpcData.length === 0) return null; // no content → empty queue
    return new Set(rpcData.map((r: { id: string }) => r.id));
  }

  // ── Fallback: sequential tree walk ──
  console.warn(
    `[study-queue] get_course_summary_ids RPC failed, using fallback: ${rpcError?.message}`,
  );

  const { data: semesters } = await db
    .from("semesters")
    .select("id")
    .eq("course_id", courseId)
    .is("deleted_at", null);

  if (!semesters || semesters.length === 0) return null;
  const semesterIds = semesters.map((s: { id: string }) => s.id);

  const { data: sections } = await db
    .from("sections")
    .select("id")
    .in("semester_id", semesterIds)
    .is("deleted_at", null);

  if (!sections || sections.length === 0) return null;
  const sectionIds = sections.map((s: { id: string }) => s.id);

  const { data: topics } = await db
    .from("topics")
    .select("id")
    .in("section_id", sectionIds)
    .is("deleted_at", null);

  if (!topics || topics.length === 0) return null;
  const topicIds = topics.map((t: { id: string }) => t.id);

  const { data: summaries } = await db
    .from("summaries")
    .select("id")
    .in("topic_id", topicIds)
    .is("deleted_at", null);

  if (!summaries || summaries.length === 0) return null;
  return new Set(summaries.map((s: { id: string }) => s.id));
}

// ─── Route: GET /study-queue ──────────────────────────────────────────

studyQueueRoutes.get(`${PREFIX}/study-queue`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // Parse query params
  const courseId = c.req.query("course_id") ?? null;
  const includeFuture = c.req.query("include_future") === "1";
  let limit = parseInt(c.req.query("limit") ?? "20", 10);
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;

  if (courseId && !isUuid(courseId)) {
    return err(c, "course_id must be a valid UUID", 400);
  }

  const now = new Date();

  try {
    // ── M-1 FIX: Parallel fetch of all independent data ───────────
    // Steps 1-3 are completely independent. Step 4 (course filter)
    // is also independent of 1-3. Run them all in parallel.

    // Build FSRS query
    let fsrsQuery = db
      .from("fsrs_states")
      .select(
        "flashcard_id, stability, difficulty, due_at, last_review_at, reps, lapses, state",
      )
      .eq("student_id", user.id);
    if (!includeFuture) {
      fsrsQuery = fsrsQuery.lte("due_at", now.toISOString());
    }
    fsrsQuery = fsrsQuery.order("due_at", { ascending: true });

    // Build flashcards query
    const flashcardsQuery = db
      .from("flashcards")
      .select(
        "id, summary_id, keyword_id, subtopic_id, front, back, front_image_url, back_image_url",
      )
      .is("deleted_at", null)
      .eq("is_active", true);

    // Build BKT query
    const bktQuery = db
      .from("bkt_states")
      .select("subtopic_id, p_know, total_attempts, correct_attempts, delta")
      .eq("student_id", user.id);

    // ── Fire all queries in parallel ──────────────────────────────
    const [bktResult, fsrsResult, flashcardsResult, allowedSummaryIds] =
      await Promise.all([
        bktQuery,
        fsrsQuery,
        flashcardsQuery,
        courseId
          ? resolveSummaryIdsForCourse(db, courseId)
          : Promise.resolve(undefined), // undefined = no filter
      ]);

    // ── Check for errors ──────────────────────────────────────────
    if (bktResult.error) {
      return err(
        c,
        `Fetch bkt_states failed: ${bktResult.error.message}`,
        500,
      );
    }
    if (fsrsResult.error) {
      return err(
        c,
        `Fetch fsrs_states failed: ${fsrsResult.error.message}`,
        500,
      );
    }
    if (flashcardsResult.error) {
      return err(
        c,
        `Fetch flashcards failed: ${flashcardsResult.error.message}`,
        500,
      );
    }

    // Course filter returned null = no content in course
    if (courseId && allowedSummaryIds === null) {
      return ok(c, {
        queue: [],
        meta: {
          total_due: 0,
          total_new: 0,
          total_in_queue: 0,
          returned: 0,
          limit,
          include_future: includeFuture,
          course_id: courseId,
          generated_at: now.toISOString(),
          algorithm: "v4.2",
          weights: NEED_CONFIG,
        },
      });
    }

    // ── Build lookup maps ─────────────────────────────────────────

    // BKT: index by subtopic_id
    const bktMap = new Map<
      string,
      { p_know: number; total_attempts: number }
    >();
    for (const bkt of bktResult.data ?? []) {
      bktMap.set(bkt.subtopic_id, {
        p_know: bkt.p_know ?? 0,
        total_attempts: bkt.total_attempts ?? 0,
      });
    }

    // FSRS: index by flashcard_id
    const fsrsMap = new Map<
      string,
      {
        stability: number;
        difficulty: number;
        due_at: string;
        last_review_at: string | null;
        reps: number;
        lapses: number;
        state: string;
      }
    >();
    for (const fs of fsrsResult.data ?? []) {
      fsrsMap.set(fs.flashcard_id, {
        stability: fs.stability ?? 1,
        difficulty: fs.difficulty ?? 5,
        due_at: fs.due_at,
        last_review_at: fs.last_review_at ?? null,
        reps: fs.reps ?? 0,
        lapses: fs.lapses ?? 0,
        state: fs.state ?? "new",
      });
    }

    // ── Build the priority queue ──────────────────────────────────

    interface QueueItem {
      flashcard_id: string;
      summary_id: string;
      keyword_id: string;
      subtopic_id: string | null;
      front: string;
      back: string;
      front_image_url: string | null;
      back_image_url: string | null;
      need_score: number;
      retention: number;
      mastery_color: string;
      p_know: number;
      fsrs_state: string;
      due_at: string | null;
      stability: number;
      difficulty: number;
      is_new: boolean;
    }

    const queue: QueueItem[] = [];
    let totalNew = 0;
    let totalReview = 0;

    for (const card of flashcardsResult.data ?? []) {
      // Apply course filter
      if (
        allowedSummaryIds instanceof Set &&
        !allowedSummaryIds.has(card.summary_id)
      ) {
        continue;
      }

      const fsrs = fsrsMap.get(card.id);
      const isNew = !fsrs;
      const subtopicId = card.subtopic_id ?? null;

      // Get BKT mastery for this card's subtopic
      const bkt = subtopicId ? bktMap.get(subtopicId) : null;
      const pKnow = bkt?.p_know ?? 0;

      // For cards with FSRS state: check if due
      if (fsrs && !includeFuture) {
        const dueDate = new Date(fsrs.due_at);
        if (dueDate > now) continue;
      }

      // Calculate NeedScore
      const needScore = calculateNeedScore(
        {
          dueAt: fsrs?.due_at ?? null,
          fsrsLapses: fsrs?.lapses ?? 0,
          fsrsReps: fsrs?.reps ?? 0,
          fsrsState: fsrs?.state ?? "new",
          fsrsStability: fsrs?.stability ?? 1,
          pKnow,
        },
        now,
      );

      // Calculate current retention
      const retention = fsrs
        ? calculateRetention(fsrs.last_review_at, fsrs.stability, now)
        : 0;

      if (isNew) totalNew++;
      else totalReview++;

      queue.push({
        flashcard_id: card.id,
        summary_id: card.summary_id,
        keyword_id: card.keyword_id,
        subtopic_id: subtopicId,
        front: card.front,
        back: card.back,
        front_image_url: card.front_image_url ?? null,
        back_image_url: card.back_image_url ?? null,
        need_score: Math.round(needScore * 1000) / 1000,
        retention: Math.round(retention * 1000) / 1000,
        mastery_color: getMasteryColor(pKnow),
        p_know: Math.round(pKnow * 1000) / 1000,
        fsrs_state: fsrs?.state ?? "new",
        due_at: fsrs?.due_at ?? null,
        stability: fsrs?.stability ?? 1,
        difficulty: fsrs?.difficulty ?? 5,
        is_new: isNew,
      });
    }

    // ── Sort by NeedScore descending ──────────────────────────────
    queue.sort((a, b) => {
      if (b.need_score !== a.need_score) return b.need_score - a.need_score;
      if (a.retention !== b.retention) return a.retention - b.retention;
      if (a.is_new !== b.is_new) return a.is_new ? 1 : -1;
      return 0;
    });

    // ── Apply limit and return ────────────────────────────────────
    const limited = queue.slice(0, limit);

    return ok(c, {
      queue: limited,
      meta: {
        total_due: totalReview,
        total_new: totalNew,
        total_in_queue: queue.length,
        returned: limited.length,
        limit,
        include_future: includeFuture,
        course_id: courseId,
        generated_at: now.toISOString(),
        algorithm: "v4.2",
        weights: NEED_CONFIG,
      },
    });
  } catch (e) {
    console.error("[StudyQueue] Unexpected error:", e);
    return err(
      c,
      `Study queue generation failed: ${(e as Error).message}`,
      500,
    );
  }
});
