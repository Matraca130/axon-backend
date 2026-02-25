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
 * Algorithm params (v4.2):
 *   BKT:  P_LEARN=0.18, P_FORGET=0.25, RECOVERY_FACTOR=3.0
 *   FSRS: stability-based scheduling with difficulty [0,10]
 *   NeedScore: exponential overdue weighting, grace period = 1 day
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "./db.ts";
import { isUuid } from "./validate.ts";

export const studyQueueRoutes = new Hono();

// ─── NeedScore Configuration (v4.2) ──────────────────────────────────

const NEED_CONFIG = {
  overdueWeight: 0.40,
  masteryWeight: 0.30,
  fragilityWeight: 0.20,
  noveltyWeight: 0.10,
  graceDays: 1, // Days after due before overdue reaches 1.0
};

// ─── NeedScore Calculation ────────────────────────────────────────────

interface NeedScoreInput {
  // From FSRS
  dueAt: string | null;
  fsrsLapses: number;
  fsrsReps: number;
  fsrsState: string; // "new" | "learning" | "review" | "relearning"
  fsrsStability: number;
  // From BKT
  pKnow: number; // subtopic mastery [0, 1]
}

function calculateNeedScore(input: NeedScoreInput, now: Date): number {
  const {
    dueAt,
    fsrsLapses,
    fsrsReps,
    fsrsState,
    pKnow,
  } = input;

  // Factor 1: Overdue (exponential, capped at 1.0)
  let overdue = 0;
  if (!dueAt) {
    overdue = 1.0; // Never scheduled = immediately due
  } else {
    const dueDate = new Date(dueAt);
    const daysOverdue =
      (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOverdue > 0) {
      // Exponential: reaches ~0.63 at graceDays, ~0.86 at 2x graceDays
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
  if (pKnow < 0) return "gray"; // no data
  if (pKnow >= 0.80) return "green";
  if (pKnow >= 0.50) return "yellow";
  return "red";
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
    // ── Step 1: Fetch all BKT states for this student ──────────────
    const { data: bktStates, error: bktErr } = await db
      .from("bkt_states")
      .select("subtopic_id, p_know, total_attempts, correct_attempts, delta")
      .eq("student_id", user.id);

    if (bktErr) {
      return err(c, `Fetch bkt_states failed: ${bktErr.message}`, 500);
    }

    // Index by subtopic_id for O(1) lookup
    const bktMap = new Map<string, { p_know: number; total_attempts: number }>();
    for (const bkt of bktStates ?? []) {
      bktMap.set(bkt.subtopic_id, {
        p_know: bkt.p_know ?? 0,
        total_attempts: bkt.total_attempts ?? 0,
      });
    }

    // ── Step 2: Fetch FSRS states for this student ─────────────────
    let fsrsQuery = db
      .from("fsrs_states")
      .select(
        "flashcard_id, stability, difficulty, due_at, last_review_at, reps, lapses, state",
      )
      .eq("student_id", user.id);

    // If not including future, only get due or overdue cards
    if (!includeFuture) {
      fsrsQuery = fsrsQuery.lte("due_at", now.toISOString());
    }

    // Order by due_at ascending (most overdue first)
    fsrsQuery = fsrsQuery.order("due_at", { ascending: true });

    const { data: fsrsStates, error: fsrsErr } = await fsrsQuery;

    if (fsrsErr) {
      return err(c, `Fetch fsrs_states failed: ${fsrsErr.message}`, 500);
    }

    // ── Step 3: Fetch flashcard details ────────────────────────────
    // Get all active, non-deleted flashcards
    const flashcardsQuery = db
      .from("flashcards")
      .select("id, summary_id, keyword_id, subtopic_id, front, back, front_image_url, back_image_url")
      .is("deleted_at", null)
      .eq("is_active", true);

    const { data: allFlashcards, error: fcErr } = await flashcardsQuery;

    if (fcErr) {
      return err(c, `Fetch flashcards failed: ${fcErr.message}`, 500);
    }

    // ── Step 4: If course_id filter, resolve which summaries belong ─
    let allowedSummaryIds: Set<string> | null = null;

    if (courseId) {
      // Course -> Semesters -> Sections -> Topics -> Summaries
      const { data: semesters } = await db
        .from("semesters")
        .select("id")
        .eq("course_id", courseId)
        .is("deleted_at", null);

      if (semesters && semesters.length > 0) {
        const semesterIds = semesters.map((s: { id: string }) => s.id);

        const { data: sections } = await db
          .from("sections")
          .select("id")
          .in("semester_id", semesterIds)
          .is("deleted_at", null);

        if (sections && sections.length > 0) {
          const sectionIds = sections.map((s: { id: string }) => s.id);

          const { data: topics } = await db
            .from("topics")
            .select("id")
            .in("section_id", sectionIds)
            .is("deleted_at", null);

          if (topics && topics.length > 0) {
            const topicIds = topics.map((t: { id: string }) => t.id);

            const { data: summaries } = await db
              .from("summaries")
              .select("id")
              .in("topic_id", topicIds)
              .is("deleted_at", null);

            allowedSummaryIds = new Set(
              (summaries ?? []).map((s: { id: string }) => s.id),
            );
          }
        }
      }

      // If course has no content, return empty queue
      if (!allowedSummaryIds || allowedSummaryIds.size === 0) {
        return ok(c, {
          queue: [],
          meta: {
            total_due: 0,
            total_new: 0,
            total_review: 0,
            generated_at: now.toISOString(),
          },
        });
      }
    }

    // ── Step 5: Build the priority queue ───────────────────────────

    // Index FSRS states by flashcard_id
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
    for (const fs of fsrsStates ?? []) {
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

    for (const card of allFlashcards ?? []) {
      // Apply course filter
      if (allowedSummaryIds && !allowedSummaryIds.has(card.summary_id)) {
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
        if (dueDate > now) continue; // Not yet due, skip
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

    // ── Step 6: Sort by NeedScore descending ──────────────────────
    queue.sort((a, b) => {
      // Primary: NeedScore (higher = more urgent)
      if (b.need_score !== a.need_score) return b.need_score - a.need_score;
      // Secondary: retention (lower = more forgotten)
      if (a.retention !== b.retention) return a.retention - b.retention;
      // Tertiary: new cards after due cards
      if (a.is_new !== b.is_new) return a.is_new ? 1 : -1;
      return 0;
    });

    // ── Step 7: Apply limit and return ────────────────────────────
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
