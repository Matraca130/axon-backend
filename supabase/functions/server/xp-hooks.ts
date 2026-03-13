/**
 * xp-hooks.ts — afterWrite hooks for XP awarding in Axon v4.4
 *
 * Uses the same afterWrite pattern as summary-hook.ts.
 * Fire-and-forget: HTTP response is NEVER delayed.
 *
 * Hook into existing registerCrud() calls by adding:
 *   afterWrite: xpHookForReview
 *
 * CONTRACT COMPLIANCE:
 *   §2.5 — Uses getAdminClient() singleton
 *   §4.3 — Fire-and-forget, never awaited
 *   §5.4 — institution_id resolved via course lookup chain
 *   §7.14 — No XP for notes/annotations
 *
 * COMPLETE COVERAGE (PR #99):
 *   All 11 XP_TABLE actions now have hooks:
 *   - review_flashcard / review_correct → xpHookForReview
 *   - quiz_answer / quiz_correct → xpHookForQuizAttempt
 *   - complete_session → xpHookForSessionComplete
 *   - complete_reading → xpHookForReadingComplete
 *   - complete_video → xpHookForVideoComplete (NEW)
 *   - complete_plan_task → xpHookForPlanTaskComplete (NEW)
 *   - complete_plan → xpHookForPlanComplete (NEW)
 *   - rag_question → xpHookForRagQuestion (NEW)
 *   - streak_daily → handled inline in POST /daily-check-in
 *   + xpHookForBatchReviews (NEW) — batch-aware review XP
 */

import type { AfterWriteParams } from "./crud-factory.ts";
import { awardXP, XP_TABLE } from "./xp-engine.ts";
import { getAdminClient } from "./db.ts";

// ─── Helper: Resolve institution_id from study session ───────
// study_sessions does NOT have institution_id (contract §5.4)
// Resolve: session.course_id → courses.institution_id

async function resolveInstitutionFromSession(
  sessionId: string,
): Promise<string | null> {
  const db = getAdminClient();

  try {
    const { data: session } = await db
      .from("study_sessions")
      .select("course_id")
      .eq("id", sessionId)
      .single();

    if (!session?.course_id) return null;

    const { data: course } = await db
      .from("courses")
      .select("institution_id")
      .eq("id", session.course_id)
      .single();

    return course?.institution_id ?? null;
  } catch {
    return null;
  }
}

// ─── Helper: Get bonus context (parallel fetch) ──────────────

async function getBonusContext(
  studentId: string,
  flashcardId?: string,
): Promise<{
  fsrsDueAt: string | null;
  bktPKnow: number | null;
  currentStreak: number;
}> {
  const db = getAdminClient();
  const result = {
    fsrsDueAt: null as string | null,
    bktPKnow: null as number | null,
    currentStreak: 0,
  };

  try {
    const promises: Promise<void>[] = [];

    if (flashcardId) {
      // FSRS due_at for on-time bonus
      promises.push(
        (async () => {
          const { data: fsrs } = await db
            .from("fsrs_states")
            .select("due_at")
            .eq("student_id", studentId)
            .eq("flashcard_id", flashcardId)
            .single();
          result.fsrsDueAt = fsrs?.due_at ?? null;
        })(),
      );

      // BKT p_know for flow zone bonus
      promises.push(
        (async () => {
          const { data: card } = await db
            .from("flashcards")
            .select("subtopic_id")
            .eq("id", flashcardId)
            .single();

          if (card?.subtopic_id) {
            const { data: bkt } = await db
              .from("bkt_states")
              .select("p_know")
              .eq("student_id", studentId)
              .eq("subtopic_id", card.subtopic_id)
              .single();
            result.bktPKnow = bkt?.p_know ?? null;
          }
        })(),
      );
    }

    // Streak for multiplier
    promises.push(
      (async () => {
        const { data: stats } = await db
          .from("student_stats")
          .select("current_streak")
          .eq("student_id", studentId)
          .single();
        result.currentStreak = stats?.current_streak ?? 0;
      })(),
    );

    await Promise.all(promises);
  } catch (e) {
    console.warn("[XP Hooks] getBonusContext error:", (e as Error).message);
  }

  return result;
}

// ─── Hook: Flashcard Review XP ───────────────────────────────
/**
 * Triggered after POST /reviews (flashcard review submission).
 * Determines correct/incorrect based on grade, resolves institution_id,
 * fetches bonus context, and awards XP fire-and-forget.
 *
 * Grade mapping (from lib/types.ts):
 *   1 = Again (incorrect), 2 = Hard, 3 = Good (correct), 4 = Easy (correct)
 * BKT correct threshold: grade >= 3 (§6.1 THRESHOLDS.BKT_CORRECT_MIN_GRADE)
 */
export function xpHookForReview(params: AfterWriteParams): void {
  const { row, userId } = params;
  if (params.action !== "create") return;

  // Fire-and-forget async IIFE (contract §4.3)
  (async () => {
    try {
      const sessionId = row.session_id as string;
      if (!sessionId) return;

      const institutionId = await resolveInstitutionFromSession(sessionId);
      if (!institutionId) {
        console.warn(
          "[XP Hook] Could not resolve institution for session:",
          sessionId,
        );
        return;
      }

      const isCorrect = (row.grade as number) >= 3;
      const xpBase = isCorrect
        ? XP_TABLE.review_correct
        : XP_TABLE.review_flashcard;
      const flashcardId = row.item_id as string;

      const bonus = await getBonusContext(userId, flashcardId);

      await awardXP({
        db: getAdminClient(),
        studentId: userId,
        institutionId,
        action: isCorrect ? "review_correct" : "review_flashcard",
        xpBase,
        sourceType: "flashcard",
        sourceId: flashcardId,
        ...bonus,
      });
    } catch (e) {
      console.warn("[XP Hook] review error:", (e as Error).message);
    }
  })();
}

// ─── Hook: Quiz Answer XP ────────────────────────────────────
/**
 * Triggered after POST /quiz-attempts.
 * Awards quiz_correct (15 XP) or quiz_answer (5 XP).
 * Resolves institution via resolve_parent_institution RPC.
 */
export function xpHookForQuizAttempt(params: AfterWriteParams): void {
  const { row, userId } = params;
  if (params.action !== "create") return;

  (async () => {
    try {
      const isCorrect = row.is_correct === true;
      const xpBase = isCorrect ? XP_TABLE.quiz_correct : XP_TABLE.quiz_answer;

      // Resolve institution via RPC
      const summaryId = row.summary_id as string;
      if (!summaryId) return;

      const db = getAdminClient();
      const { data: instId } = await db.rpc("resolve_parent_institution", {
        p_table: "summaries",
        p_id: summaryId,
      });
      if (!instId) return;

      const bonus = await getBonusContext(userId);

      await awardXP({
        db,
        studentId: userId,
        institutionId: instId as string,
        action: isCorrect ? "quiz_correct" : "quiz_answer",
        xpBase,
        sourceType: "quiz",
        sourceId: row.id as string,
        currentStreak: bonus.currentStreak,
      });
    } catch (e) {
      console.warn("[XP Hook] quiz error:", (e as Error).message);
    }
  })();
}

// ─── Hook: Study Session Complete XP ─────────────────────────
/**
 * Triggered after PUT /study-sessions/:id (when completed_at is set).
 * Awards complete_session (25 XP).
 * Only fires when completed_at is in the updatedFields array.
 */
export function xpHookForSessionComplete(params: AfterWriteParams): void {
  const { row, userId, updatedFields } = params;
  if (params.action !== "update") return;

  // Only trigger when completed_at is being set
  if (!updatedFields?.includes("completed_at")) return;
  if (!row.completed_at) return;

  (async () => {
    try {
      const institutionId = await resolveInstitutionFromSession(
        row.id as string,
      );
      if (!institutionId) return;

      const bonus = await getBonusContext(userId);

      await awardXP({
        db: getAdminClient(),
        studentId: userId,
        institutionId,
        action: "complete_session",
        xpBase: XP_TABLE.complete_session,
        sourceType: "session",
        sourceId: row.id as string,
        currentStreak: bonus.currentStreak,
      });
    } catch (e) {
      console.warn("[XP Hook] session complete error:", (e as Error).message);
    }
  })();
}

// ─── Hook: Reading Complete XP ───────────────────────────────
/**
 * Triggered after PUT /reading-states/:id (when completed = true).
 * Awards complete_reading (30 XP).
 */
export function xpHookForReadingComplete(params: AfterWriteParams): void {
  const { row, userId, updatedFields } = params;
  if (params.action !== "update") return;
  if (!updatedFields?.includes("completed")) return;
  if (row.completed !== true) return;

  (async () => {
    try {
      const summaryId = row.summary_id as string;
      if (!summaryId) return;

      const db = getAdminClient();
      const { data: instId } = await db.rpc("resolve_parent_institution", {
        p_table: "summaries",
        p_id: summaryId,
      });
      if (!instId) return;

      const bonus = await getBonusContext(userId);

      await awardXP({
        db,
        studentId: userId,
        institutionId: instId as string,
        action: "complete_reading",
        xpBase: XP_TABLE.complete_reading,
        sourceType: "reading",
        sourceId: row.id as string,
        currentStreak: bonus.currentStreak,
      });
    } catch (e) {
      console.warn("[XP Hook] reading error:", (e as Error).message);
    }
  })();
}

// ═══════════════════════════════════════════════════════════════
// NEW HOOKS (PR #99) — Complete XP_TABLE coverage
// ═══════════════════════════════════════════════════════════════

// ─── Hook: Video Complete XP ─────────────────────────────────
/**
 * Called directly from tracking.ts on first video completion.
 * Awards complete_video (20 XP).
 *
 * NOT an afterWrite hook — called explicitly because tracking.ts
 * uses upsert_video_view RPC (not CRUD factory).
 *
 * @param studentId — The student's UUID
 * @param videoId — The video UUID
 * @param institutionId — Already resolved by tracking.ts
 */
export function xpHookForVideoComplete(
  studentId: string,
  videoId: string,
  institutionId: string,
): void {
  (async () => {
    try {
      const bonus = await getBonusContext(studentId);

      await awardXP({
        db: getAdminClient(),
        studentId,
        institutionId,
        action: "complete_video",
        xpBase: XP_TABLE.complete_video,
        sourceType: "video",
        sourceId: videoId,
        currentStreak: bonus.currentStreak,
      });
    } catch (e) {
      console.warn("[XP Hook] video complete error:", (e as Error).message);
    }
  })();
}

// ─── Hook: Study Plan Task Complete XP ───────────────────────
/**
 * Triggered after PUT /study-plan-tasks/:id (when status → completed).
 * Awards complete_plan_task (15 XP).
 *
 * Also checks if ALL tasks in the parent plan are now completed;
 * if so, fires xpHookForPlanComplete as well.
 *
 * Uses afterWrite pattern from CRUD factory.
 */
export function xpHookForPlanTaskComplete(params: AfterWriteParams): void {
  const { row, userId, updatedFields } = params;
  if (params.action !== "update") return;

  // Only trigger when status changes
  if (!updatedFields?.includes("status")) return;
  if (row.status !== "completed") return;

  (async () => {
    try {
      const db = getAdminClient();
      const studyPlanId = row.study_plan_id as string;
      if (!studyPlanId) return;

      // Resolve institution: study_plan → course → institution
      const { data: plan } = await db
        .from("study_plans")
        .select("course_id")
        .eq("id", studyPlanId)
        .single();

      if (!plan?.course_id) return;

      const { data: course } = await db
        .from("courses")
        .select("institution_id")
        .eq("id", plan.course_id)
        .single();

      if (!course?.institution_id) return;
      const institutionId = course.institution_id;

      const bonus = await getBonusContext(userId);

      // Award task completion XP
      await awardXP({
        db,
        studentId: userId,
        institutionId,
        action: "complete_plan_task",
        xpBase: XP_TABLE.complete_plan_task,
        sourceType: "plan_task",
        sourceId: row.id as string,
        currentStreak: bonus.currentStreak,
      });

      // Check if ALL tasks in this plan are now completed
      const { count: totalTasks } = await db
        .from("study_plan_tasks")
        .select("id", { count: "exact", head: true })
        .eq("study_plan_id", studyPlanId);

      const { count: completedTasks } = await db
        .from("study_plan_tasks")
        .select("id", { count: "exact", head: true })
        .eq("study_plan_id", studyPlanId)
        .eq("status", "completed");

      if (
        totalTasks !== null &&
        completedTasks !== null &&
        totalTasks > 0 &&
        completedTasks >= totalTasks
      ) {
        // All tasks completed → award plan completion XP!
        console.log(
          `[XP Hook] All ${totalTasks} tasks completed for plan ${studyPlanId}. Awarding plan XP.`,
        );
        await awardXP({
          db,
          studentId: userId,
          institutionId,
          action: "complete_plan",
          xpBase: XP_TABLE.complete_plan,
          sourceType: "plan",
          sourceId: studyPlanId,
          currentStreak: bonus.currentStreak,
        });
      }
    } catch (e) {
      console.warn("[XP Hook] plan task complete error:", (e as Error).message);
    }
  })();
}

// ─── Hook: RAG Question XP ──────────────────────────────────
/**
 * Called directly from chat.ts after successful RAG chat response.
 * Awards rag_question (5 XP).
 *
 * NOT an afterWrite hook — called explicitly because chat.ts
 * is a custom endpoint (not CRUD factory).
 *
 * @param studentId — The student's UUID
 * @param institutionId — Already resolved by chat.ts
 * @param logId — The rag_query_log UUID (for source tracking)
 */
export function xpHookForRagQuestion(
  studentId: string,
  institutionId: string,
  logId: string,
): void {
  (async () => {
    try {
      const bonus = await getBonusContext(studentId);

      await awardXP({
        db: getAdminClient(),
        studentId,
        institutionId,
        action: "rag_question",
        xpBase: XP_TABLE.rag_question,
        sourceType: "rag_chat",
        sourceId: logId,
        currentStreak: bonus.currentStreak,
      });
    } catch (e) {
      console.warn("[XP Hook] RAG question error:", (e as Error).message);
    }
  })();
}

// ─── Hook: Batch Reviews XP ─────────────────────────────────
/**
 * Called from batch-review.ts after successfully processing a batch.
 * Resolves institution ONCE from session_id, then awards XP for
 * each review in a fire-and-forget loop.
 *
 * Optimization: getBonusContext is called once for the batch
 * (streak doesn't change mid-batch). Each review gets its own
 * FSRS/BKT bonus context for on-time/flow-zone bonuses.
 *
 * @param studentId — The student's UUID
 * @param sessionId — The study session UUID
 * @param reviews — Array of { item_id, grade, instrument_type }
 */
export function xpHookForBatchReviews(
  studentId: string,
  sessionId: string,
  reviews: Array<{ item_id: string; grade: number; instrument_type: string }>,
): void {
  if (reviews.length === 0) return;

  (async () => {
    try {
      const institutionId = await resolveInstitutionFromSession(sessionId);
      if (!institutionId) {
        console.warn(
          "[XP Hook] Batch: Could not resolve institution for session:",
          sessionId,
        );
        return;
      }

      const db = getAdminClient();

      // Get streak once for the entire batch
      let currentStreak = 0;
      try {
        const { data: stats } = await db
          .from("student_stats")
          .select("current_streak")
          .eq("student_id", studentId)
          .single();
        currentStreak = stats?.current_streak ?? 0;
      } catch {
        // Non-critical, continue without streak bonus
      }

      // Process each review (fire-and-forget per review)
      for (const review of reviews) {
        try {
          const isCorrect = review.grade >= 3;
          const xpBase = isCorrect
            ? XP_TABLE.review_correct
            : XP_TABLE.review_flashcard;

          // Get per-review bonus context (FSRS due_at, BKT p_know)
          const bonus = await getBonusContext(studentId, review.item_id);

          await awardXP({
            db,
            studentId,
            institutionId,
            action: isCorrect ? "review_correct" : "review_flashcard",
            xpBase,
            sourceType: "flashcard",
            sourceId: review.item_id,
            fsrsDueAt: bonus.fsrsDueAt,
            bktPKnow: bonus.bktPKnow,
            currentStreak,
          });
        } catch (e) {
          console.warn(
            `[XP Hook] Batch review ${review.item_id} error:`,
            (e as Error).message,
          );
        }
      }

      console.log(
        `[XP Hook] Batch: Processed ${reviews.length} reviews for ${studentId}`,
      );
    } catch (e) {
      console.warn("[XP Hook] Batch reviews error:", (e as Error).message);
    }
  })();
}
