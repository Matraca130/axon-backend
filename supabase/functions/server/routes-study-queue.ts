/**
 * routes-study-queue.ts — Study Queue (Algorithmic Priority Queue) for Axon v4.4
 *
 * GET /study-queue — Returns a prioritized list of flashcards to study.
 *
 * v4.2 SPEC COMPLIANCE:
 *   - clinical_priority from keywords (exponential NeedScore scaling)
 *   - 5-color scale: red/orange/yellow/green/blue with relative Δ mode
 *   - Domination threshold: 0.70 + (priority × 0.20)
 *   - Leech detection (consecutive_lapses >= threshold)
 *   - Enriched return: reps, lapses, last_review_at, max_p_know
 *
 * S-3 FIX: Primary path uses get_study_queue() PostgreSQL RPC.
 * Falls back to JS-side logic if RPC is unavailable.
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

// ─── Constants ──────────────────────────────────────────────────────

const MAX_FALLBACK_FLASHCARDS = 10_000;
const DEFAULT_DOMINATION_BASE = 0.70;
const DEFAULT_DOMINATION_PRIORITY_SCALE = 0.20;

// ─── NeedScore Calculation (fallback) ─────────────────────────────

interface NeedScoreInput {
  dueAt: string | null;
  fsrsLapses: number;
  fsrsReps: number;
  fsrsState: string;
  fsrsStability: number;
  pKnow: number;
  clinicalPriority: number;
}

function calculateNeedScore(input: NeedScoreInput, now: Date): number {
  const { dueAt, fsrsLapses, fsrsReps, fsrsState, pKnow, clinicalPriority } = input;

  let overdue = 0;
  if (!dueAt) {
    overdue = 1.0;
  } else {
    const dueDate = new Date(dueAt);
    const daysOverdue = (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOverdue > 0) {
      overdue = 1 - Math.exp(-daysOverdue / NEED_CONFIG.graceDays);
    }
  }

  const needMastery = 1 - pKnow;
  const needFragility = Math.min(1, fsrsLapses / Math.max(1, fsrsReps + fsrsLapses + 1));
  const needNovelty = fsrsState === "new" ? 1.0 : 0.0;

  const baseScore =
    NEED_CONFIG.overdueWeight * overdue +
    NEED_CONFIG.masteryWeight * needMastery +
    NEED_CONFIG.fragilityWeight * needFragility +
    NEED_CONFIG.noveltyWeight * needNovelty;

  const priorityMultiplier = 1.0 + Math.pow(2.0, clinicalPriority * 2.0);

  return Math.max(0, baseScore * priorityMultiplier);
}

// ─── Retention: FSRS v4 power-law (matches fsrs-v4.ts) ───────────────

function calculateRetention(
  lastReviewAt: string | null,
  stabilityDays: number,
  now: Date,
): number {
  if (!lastReviewAt || stabilityDays <= 0) return 0;
  const daysSince = (now.getTime() - new Date(lastReviewAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.min(1, Math.pow(1 + daysSince / (9 * stabilityDays), -1)));
}

// ─── 5-Color Scale (§6.2) ─────────────────────────────────────────

function getMasteryColor(
  pKnow: number,
  retention: number,
  clinicalPriority: number,
): "blue" | "green" | "yellow" | "orange" | "red" | "gray" {
  if (pKnow <= 0) return "gray";

  const displayMastery = pKnow * (retention > 0 ? retention : (pKnow > 0 ? 1.0 : 0.0));
  const threshold = DEFAULT_DOMINATION_BASE + clinicalPriority * DEFAULT_DOMINATION_PRIORITY_SCALE;
  const delta = threshold > 0 ? displayMastery / threshold : 0;

  if (delta >= 1.10) return "blue";
  if (delta >= 1.00) return "green";
  if (delta >= 0.85) return "yellow";
  if (delta >= 0.50) return "orange";
  return "red";
}

// ─── Course → Summary IDs resolution (fallback) ─────────────────

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

  console.warn(`[study-queue] RPC failed, using fallback: ${rpcError?.message}`);

  const { data: semesters } = await db.from("semesters").select("id").eq("course_id", courseId).is("deleted_at", null);
  if (!semesters || semesters.length === 0) return null;
  const semesterIds = semesters.map((s: { id: string }) => s.id);

  const { data: sections } = await db.from("sections").select("id").in("semester_id", semesterIds).is("deleted_at", null);
  if (!sections || sections.length === 0) return null;
  const sectionIds = sections.map((s: { id: string }) => s.id);

  const { data: topics } = await db.from("topics").select("id").in("section_id", sectionIds).is("deleted_at", null);
  if (!topics || topics.length === 0) return null;
  const topicIds = topics.map((t: { id: string }) => t.id);

  const { data: summaries } = await db.from("summaries").select("id").in("topic_id", topicIds).is("deleted_at", null);
  if (!summaries || summaries.length === 0) return null;
  return new Set(summaries.map((s: { id: string }) => s.id));
}

async function resolveSummaryIdsForStudent(
  db: SupabaseClient,
  userId: string,
): Promise<Set<string> | null> {
  const { data: memberships } = await db.from("memberships").select("institution_id").eq("user_id", userId).eq("is_active", true);
  if (!memberships || memberships.length === 0) return null;
  const institutionIds = memberships.map((m: { institution_id: string }) => m.institution_id);

  const { data: courses } = await db.from("courses").select("id").in("institution_id", institutionIds).eq("is_active", true);
  if (!courses || courses.length === 0) return null;
  const courseIds = courses.map((c: { id: string }) => c.id);

  const { data: semesters } = await db.from("semesters").select("id").in("course_id", courseIds).is("deleted_at", null);
  if (!semesters || semesters.length === 0) return null;
  const semesterIds = semesters.map((s: { id: string }) => s.id);

  const { data: sections } = await db.from("sections").select("id").in("semester_id", semesterIds).is("deleted_at", null);
  if (!sections || sections.length === 0) return null;
  const sectionIds = sections.map((s: { id: string }) => s.id);

  const { data: topics } = await db.from("topics").select("id").in("section_id", sectionIds).is("deleted_at", null);
  if (!topics || topics.length === 0) return null;
  const topicIds = topics.map((t: { id: string }) => t.id);

  const { data: summaries } = await db.from("summaries").select("id").in("topic_id", topicIds).is("deleted_at", null);
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
      console.warn(`[StudyQueue] RPC failed: ${error.message}. Falling back to JS.`);
      return null;
    }

    if (!data || data.length === 0) {
      return { queue: [], totalDue: 0, totalNew: 0, totalInQueue: 0 };
    }

    const totalInQueue = Number(data[0].total_count) || 0;

    let totalNew = 0;
    let totalDue = 0;
    for (const item of data) {
      if (item.is_new) totalNew++;
      else totalDue++;
    }

    const queue = data.map((item: Record<string, unknown>) => {
      const { total_count: _tc, ...rest } = item;
      return rest;
    });

    return { queue, totalDue, totalNew, totalInQueue };
  } catch (e) {
    console.warn(`[StudyQueue] RPC exception: ${(e as Error).message}. Falling back to JS.`);
    return null;
  }
}

// ─── Fallback: JS-based study queue ──────────────────────────────

async function getStudyQueueFromJs(
  db: SupabaseClient,
  userId: string,
  courseId: string | null,
  limit: number,
  includeFuture: boolean,
  now: Date,
): Promise<{ queue: unknown[]; totalDue: number; totalNew: number; totalInQueue: number }> {
  let fsrsQuery = db
    .from("fsrs_states")
    .select("flashcard_id, stability, difficulty, due_at, last_review_at, reps, lapses, state, consecutive_lapses, is_leech")
    .eq("student_id", userId);
  if (!includeFuture) {
    fsrsQuery = fsrsQuery.lte("due_at", now.toISOString());
  }
  fsrsQuery = fsrsQuery.order("due_at", { ascending: true });

  const flashcardsQuery = db
    .from("flashcards")
    .select("id, summary_id, keyword_id, subtopic_id, front, back, front_image_url, back_image_url")
    .is("deleted_at", null)
    .eq("is_active", true)
    .eq("status", "published")
    .limit(MAX_FALLBACK_FLASHCARDS);

  const bktQuery = db
    .from("bkt_states")
    .select("subtopic_id, p_know, max_p_know, total_attempts, correct_attempts, delta")
    .eq("student_id", userId);

  const keywordsQuery = db
    .from("keywords")
    .select("id, clinical_priority")
    .is("deleted_at", null);

  const [bktResult, fsrsResult, flashcardsResult, keywordsResult, allowedSummaryIds] =
    await Promise.all([
      bktQuery,
      fsrsQuery,
      flashcardsQuery,
      keywordsQuery,
      courseId
        ? resolveSummaryIdsForCourse(db, courseId)
        : resolveSummaryIdsForStudent(db, userId),
    ]);

  if (bktResult.error) throw new Error(`Fetch bkt_states failed: ${bktResult.error.message}`);
  if (fsrsResult.error) throw new Error(`Fetch fsrs_states failed: ${fsrsResult.error.message}`);
  if (flashcardsResult.error) throw new Error(`Fetch flashcards failed: ${flashcardsResult.error.message}`);

  if (allowedSummaryIds === null) {
    return { queue: [], totalDue: 0, totalNew: 0, totalInQueue: 0 };
  }

  const bktMap = new Map<string, { p_know: number; max_p_know: number; total_attempts: number }>();
  for (const bkt of bktResult.data ?? []) {
    bktMap.set(bkt.subtopic_id, {
      p_know: bkt.p_know ?? 0,
      max_p_know: bkt.max_p_know ?? 0,
      total_attempts: bkt.total_attempts ?? 0,
    });
  }

  const fsrsMap = new Map<string, {
    stability: number; difficulty: number; due_at: string;
    last_review_at: string | null; reps: number; lapses: number;
    state: string; consecutive_lapses: number; is_leech: boolean;
  }>();
  for (const fs of fsrsResult.data ?? []) {
    fsrsMap.set(fs.flashcard_id, {
      stability: fs.stability ?? 1,
      difficulty: fs.difficulty ?? 5,
      due_at: fs.due_at,
      last_review_at: fs.last_review_at ?? null,
      reps: fs.reps ?? 0,
      lapses: fs.lapses ?? 0,
      state: fs.state ?? "new",
      consecutive_lapses: fs.consecutive_lapses ?? 0,
      is_leech: fs.is_leech ?? false,
    });
  }

  const kwMap = new Map<string, number>();
  for (const kw of keywordsResult.data ?? []) {
    kwMap.set(kw.id, kw.clinical_priority ?? 0);
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
    reps: number;
    lapses: number;
    last_review_at: string | null;
    max_p_know: number;
    clinical_priority: number;
    consecutive_lapses: number;
    is_leech: boolean;
  }

  const queue: QueueItem[] = [];
  let totalNew = 0;
  let totalReview = 0;

  for (const card of flashcardsResult.data ?? []) {
    if (allowedSummaryIds instanceof Set && !allowedSummaryIds.has(card.summary_id)) continue;

    const fsrs = fsrsMap.get(card.id);
    const isNew = !fsrs;
    const subtopicId = card.subtopic_id ?? null;
    const bkt = subtopicId ? bktMap.get(subtopicId) : null;
    const pKnow = bkt?.p_know ?? 0;
    const maxPKnow = bkt?.max_p_know ?? 0;
    const clinicalPriority = kwMap.get(card.keyword_id) ?? 0;

    if (fsrs && !includeFuture) {
      const dueDate = new Date(fsrs.due_at);
      if (dueDate > now) continue;
    }

    const needScore = calculateNeedScore({
      dueAt: fsrs?.due_at ?? null,
      fsrsLapses: fsrs?.lapses ?? 0,
      fsrsReps: fsrs?.reps ?? 0,
      fsrsState: fsrs?.state ?? "new",
      fsrsStability: fsrs?.stability ?? 1,
      pKnow,
      clinicalPriority,
    }, now);

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
      mastery_color: getMasteryColor(pKnow, retention, clinicalPriority),
      p_know: Math.round(pKnow * 1000) / 1000,
      fsrs_state: fsrs?.state ?? "new",
      due_at: fsrs?.due_at ?? null,
      stability: fsrs?.stability ?? 1,
      difficulty: fsrs?.difficulty ?? 5,
      is_new: isNew,
      reps: fsrs?.reps ?? 0,
      lapses: fsrs?.lapses ?? 0,
      last_review_at: fsrs?.last_review_at ?? null,
      max_p_know: Math.round(maxPKnow * 1000) / 1000,
      clinical_priority: clinicalPriority,
      consecutive_lapses: fsrs?.consecutive_lapses ?? 0,
      is_leech: fsrs?.is_leech ?? false,
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
    let result = await getStudyQueueFromRpc(db, user.id, courseId, limit, includeFuture);
    let engine: "sql" | "js" = "sql";

    if (result === null) {
      engine = "js";
      result = await getStudyQueueFromJs(db, user.id, courseId, limit, includeFuture, now);
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
    return err(c, `Study queue generation failed: ${(e as Error).message}`, 500);
  }
});
