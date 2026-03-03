/**
 * routes-study-queue.tsx — Study Queue (Algorithmic Priority Queue) for Axon v4.4
 *
 * GET /study-queue — Returns a prioritized list of flashcards to study.
 *
 * S-3 FIX: Primary path now uses get_study_queue() PostgreSQL RPC.
 * The entire NeedScore calculation, filtering, and ranking happens in SQL.
 * Falls back to the original JS-side logic if the RPC is unavailable.
 *
 * S-3b FIX: RPC now returns total_count via COUNT(*) OVER() so
 * total_in_queue accurately reflects ALL matching cards, not just
 * the LIMIT-ed subset returned.
 *
 * The algorithm combines three systems:
 *   1. BKT (Bayesian Knowledge Tracing) — concept-level mastery per subtopic
 *   2. FSRS (Free Spaced Repetition Scheduler) — card-level scheduling
 *   3. NeedScore — weighted urgency score per card combining:
 *      - Overdue factor (0.40), Mastery factor (0.30),
 *      - Fragility factor (0.20), Novelty factor (0.10)
 *
 * Query params:
 *   ?course_id=xxx    — optional, filter flashcards to a specific course
 *   ?limit=20         — optional, max items to return (default 20, max 100)
 *   ?include_future=0 — optional, if "1" include cards not yet due
 *
 * Response:
 *   { data: { queue: StudyQueueItem[], meta: { ... } } }
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "./db.ts";
import { isUuid } from "./validate.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js";

export const studyQueueRoutes = new Hono();

// ─── NeedScore Configuration (v4.2) ──────────────────────────────

const NEED_CONFIG = {
  overdueWeight: 0.40,
  masteryWeight: 0.30,
  fragilityWeight: 0.20,
  noveltyWeight: 0.10,
  graceDays: 1,
};

// ─── NeedScore Calculation (fallback only) ────────────────────────

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

  const needMastery = 1 - pKnow;
  const needFragility = Math.min(
    1,
    fsrsLapses / Math.max(1, fsrsReps + fsrsLapses + 1),
  );
  const needNovelty = fsrsState === "new" ? 1.0 : 0.0;

  const score =
    NEED_CONFIG.overdueWeight * overdue +
    NEED_CONFIG.masteryWeight * needMastery +
    NEED_CONFIG.fragilityWeight * needFragility +
    NEED_CONFIG.noveltyWeight * needNovelty;

  return Math.max(0, Math.min(1, score));
}

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

function getMasteryColor(pKnow: number): "green" | "yellow" | "red" | "gray" {
  if (pKnow < 0) return "gray";
  if (pKnow >= 0.80) return "green";
  if (pKnow >= 0.50) return "yellow";
  return "red";
}

// ─── Course → Summary IDs resolution (fallback only) ────────────────

async function resolveSummaryIdsForCourse(
  db: SupabaseClient,
  courseId: string,
): Promise<Set<string> | null> {
  const { data: rpcData, error: rpcError } = await db.rpc(
    "get_course_summary_ids",
    { p_course_id: courseId },
  );

  if (!rpcError && rpcData) {
    if (rpcData.length === 0) return null;
    return new Set(rpcData.map((r: { id: string }) => r.id));
  }

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

// ─── Primary: SQL-based study queue via RPC ────────────────────────

async function getStudyQueueFromRpc(
  db: SupabaseClient,
  userId: string,
  courseId: string | null,
  limit: number,
  includeFuture: boolean,
): Promise<{ queue: unknown[]; totalDue: number; totalNew: number; totalInQueue: number } | null> {
  try {
    const { data, error } = await db.rpc("get_study_queue", {
      p_student_id: userId,
      p_course_id: courseId,
      p_limit: limit,
      p_include_future: includeFuture,
    });

    if (error) {
      console.warn(
        `[StudyQueue] RPC get_study_queue failed: ${error.message}. Falling back to JS.`,
      );
      return null;
    }

    if (!data || data.length === 0) {
      return { queue: [], totalDue: 0, totalNew: 0, totalInQueue: 0 };
    }

    // S-3b FIX: Extract total_count from the first row (window function)
    // Every row has the same total_count value, so we only need the first.
    const totalInQueue = Number(data[0].total_count) || 0;

    // Count new vs review from the returned (limited) results
    let totalNew = 0;
    let totalDue = 0;
    for (const item of data) {
      if (item.is_new) totalNew++;
      else totalDue++;
    }

    // Strip total_count from response items (internal field)
    const queue = data.map((item: Record<string, unknown>) => {
      const { total_count: _tc, ...rest } = item;
      return rest;
    });

    return { queue, totalDue, totalNew, totalInQueue };
  } catch (e) {
    console.warn(
      `[StudyQueue] RPC exception: ${(e as Error).message}. Falling back to JS.`,
    );
    return null;
  }
}

// ─── Fallback: JS-based study queue (original logic) ───────────────

async function getStudyQueueFromJs(
  db: SupabaseClient,
  userId: string,
  courseId: string | null,
  limit: number,
  includeFuture: boolean,
  now: Date,
): Promise<{ queue: unknown[]; totalDue: number; totalNew: number; totalInQueue: number }> {
  // Build FSRS query
  let fsrsQuery = db
    .from("fsrs_states")
    .select(
      "flashcard_id, stability, difficulty, due_at, last_review_at, reps, lapses, state",
    )
    .eq("student_id", userId);
  if (!includeFuture) {
    fsrsQuery = fsrsQuery.lte("due_at", now.toISOString());
  }
  fsrsQuery = fsrsQuery.order("due_at", { ascending: true });

  const flashcardsQuery = db
    .from("flashcards")
    .select(
      "id, summary_id, keyword_id, subtopic_id, front, back, front_image_url, back_image_url",
    )
    .is("deleted_at", null)
    .eq("is_active", true);

  const bktQuery = db
    .from("bkt_states")
    .select("subtopic_id, p_know, total_attempts, correct_attempts, delta")
    .eq("student_id", userId);

  const [bktResult, fsrsResult, flashcardsResult, allowedSummaryIds] =
    await Promise.all([
      bktQuery,
      fsrsQuery,
      flashcardsQuery,
      courseId
        ? resolveSummaryIdsForCourse(db, courseId)
        : Promise.resolve(undefined),
    ]);

  if (bktResult.error) throw new Error(`Fetch bkt_states failed: ${bktResult.error.message}`);
  if (fsrsResult.error) throw new Error(`Fetch fsrs_states failed: ${fsrsResult.error.message}`);
  if (flashcardsResult.error) throw new Error(`Fetch flashcards failed: ${flashcardsResult.error.message}`);

  if (courseId && allowedSummaryIds === null) {
    return { queue: [], totalDue: 0, totalNew: 0, totalInQueue: 0 };
  }

  // Build lookup maps
  const bktMap = new Map<string, { p_know: number; total_attempts: number }>();
  for (const bkt of bktResult.data ?? []) {
    bktMap.set(bkt.subtopic_id, {
      p_know: bkt.p_know ?? 0,
      total_attempts: bkt.total_attempts ?? 0,
    });
  }

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
    if (
      allowedSummaryIds instanceof Set &&
      !allowedSummaryIds.has(card.summary_id)
    ) {
      continue;
    }

    const fsrs = fsrsMap.get(card.id);
    const isNew = !fsrs;
    const subtopicId = card.subtopic_id ?? null;
    const bkt = subtopicId ? bktMap.get(subtopicId) : null;
    const pKnow = bkt?.p_know ?? 0;

    if (fsrs && !includeFuture) {
      const dueDate = new Date(fsrs.due_at);
      if (dueDate > now) continue;
    }

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

  queue.sort((a, b) => {
    if (b.need_score !== a.need_score) return b.need_score - a.need_score;
    if (a.retention !== b.retention) return a.retention - b.retention;
    if (a.is_new !== b.is_new) return a.is_new ? 1 : -1;
    return 0;
  });

  return {
    queue: queue.slice(0, limit),
    totalDue: totalReview,
    totalNew: totalNew,
    totalInQueue: queue.length,
  };
}

// ─── Route: GET /study-queue ──────────────────────────────────────

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
    // ── S-3 FIX: Try SQL-based queue first (single RPC call) ──
    let result = await getStudyQueueFromRpc(
      db,
      user.id,
      courseId,
      limit,
      includeFuture,
    );

    let engine: "sql" | "js" = "sql";

    // ── Fallback to JS-based queue if RPC unavailable ──
    if (result === null) {
      engine = "js";
      result = await getStudyQueueFromJs(
        db,
        user.id,
        courseId,
        limit,
        includeFuture,
        now,
      );
    }

    return ok(c, {
      queue: result.queue,
      meta: {
        total_due: result.totalDue,
        total_new: result.totalNew,
        total_in_queue: result.totalInQueue,
        returned: result.queue.length,
        limit,
        include_future: includeFuture,
        course_id: courseId,
        generated_at: now.toISOString(),
        algorithm: "v4.2",
        weights: NEED_CONFIG,
        engine,
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
