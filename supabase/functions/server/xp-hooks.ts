/**
 * xp-hooks.ts -- afterWrite hooks for XP awarding in Axon v4.4
 *
 * Uses the same afterWrite pattern as summary-hook.ts.
 * Fire-and-forget: HTTP response is NEVER delayed.
 *
 * Hook registry (11/11 XP actions covered):
 *   1. xpHookForReview          -- POST /reviews (afterWrite)
 *   2. xpHookForQuizAttempt     -- POST /quiz-attempts (manual call)
 *   3. xpHookForSessionComplete -- PUT /study-sessions (afterWrite)
 *   4. xpHookForReadingComplete -- POST /reading-states (manual call)
 *   5. xpHookForBatchReviews    -- POST /review-batch (manual call)
 *   6. xpHookForVideoComplete   -- POST /mux/track-view (manual call)
 *   7. xpHookForRagQuestion     -- POST /ai/rag-chat (manual call)
 *   8. xpHookForPlanTaskComplete -- PUT /study-plan-tasks (afterWrite)
 *
 * streak_daily (15 XP) is handled inline in POST /daily-check-in.
 *
 * PR #108: Added stat counter increments:
 *   - Hook 1 (review): incrementReviewCounter()
 *   - Hook 3 (session complete): incrementSessionCounter()
 *   - Hook 5 (batch reviews): incrementReviewCounter() per review
 *
 * CONTRACT COMPLIANCE:
 *   S2.5 -- Uses getAdminClient() singleton
 *   S4.3 -- Fire-and-forget, never awaited
 *   S5.4 -- institution_id resolved via course lookup chain
 *   S7.14 -- No XP for notes/annotations
 */

import type { AfterWriteParams } from "./crud-factory.ts";
import { awardXP, XP_TABLE } from "./xp-engine.ts";
import { getAdminClient } from "./db.ts";
import { incrementReviewCounter, incrementSessionCounter } from "./stat-counters.ts";

// --- Helper: Resolve institution_id from study session ---

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

// --- Helper: Get bonus context (parallel fetch) ---

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

// --- Hook 1: Flashcard Review XP ---
export function xpHookForReview(params: AfterWriteParams): void {
  const { row, userId } = params;
  if (params.action !== "create") return;

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

      // PR #108: Increment daily review counter + correct streak
      incrementReviewCounter(userId, isCorrect);
    } catch (e) {
      console.warn("[XP Hook] review error:", (e as Error).message);
    }
  })();
}

// --- Hook 2: Quiz Answer XP ---
export function xpHookForQuizAttempt(params: AfterWriteParams): void {
  const { row, userId } = params;
  if (params.action !== "create") return;

  (async () => {
    try {
      const isCorrect = row.is_correct === true;
      const xpBase = isCorrect ? XP_TABLE.quiz_correct : XP_TABLE.quiz_answer;

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

// --- Hook 3: Study Session Complete XP ---
export function xpHookForSessionComplete(params: AfterWriteParams): void {
  const { row, userId, updatedFields } = params;
  if (params.action !== "update") return;
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

      // PR #108: Increment daily session counter
      incrementSessionCounter(userId);
    } catch (e) {
      console.warn("[XP Hook] session complete error:", (e as Error).message);
    }
  })();
}

// --- Hook 4: Reading Complete XP ---
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

// --- Hook 5: Batch Review XP ---
export function xpHookForBatchReviews(
  userId: string,
  sessionId: string,
  reviews: Array<{ item_id: string; grade: number; instrument_type: string }>,
): void {
  (async () => {
    try {
      const institutionId = await resolveInstitutionFromSession(sessionId);
      if (!institutionId) {
        console.warn(
          "[XP Hook] Could not resolve institution for batch session:",
          sessionId,
        );
        return;
      }

      const db = getAdminClient();
      const bonus = await getBonusContext(userId);

      const promises = reviews.map(async (review) => {
        try {
          const isCorrect = review.grade >= 3;
          const xpBase = isCorrect
            ? XP_TABLE.review_correct
            : XP_TABLE.review_flashcard;

          let reviewBonus = bonus;
          if (review.instrument_type === "flashcard") {
            try {
              reviewBonus = await getBonusContext(userId, review.item_id);
            } catch {
              // Fall back to session-level bonus
            }
          }

          await awardXP({
            db,
            studentId: userId,
            institutionId,
            action: isCorrect ? "review_correct" : "review_flashcard",
            xpBase,
            sourceType: review.instrument_type,
            sourceId: review.item_id,
            ...reviewBonus,
          });

          // PR #108: Increment per-review counters
          incrementReviewCounter(userId, isCorrect);
        } catch (e) {
          console.warn(
            `[XP Hook] batch review item ${review.item_id} error:`,
            (e as Error).message,
          );
        }
      });

      await Promise.all(promises);

      console.log(
        `[XP Hook] Batch: awarded XP for ${reviews.length} reviews in session ${sessionId}`,
      );
    } catch (e) {
      console.warn("[XP Hook] batch reviews error:", (e as Error).message);
    }
  })();
}

// --- Hook 6: Video Complete XP ---
export function xpHookForVideoComplete(
  userId: string,
  videoId: string,
  institutionId: string,
): void {
  (async () => {
    try {
      const bonus = await getBonusContext(userId);

      await awardXP({
        db: getAdminClient(),
        studentId: userId,
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

// --- Hook 7: RAG Question XP ---
export function xpHookForRagQuestion(
  userId: string,
  institutionId: string,
  logId: string,
): void {
  (async () => {
    try {
      const bonus = await getBonusContext(userId);

      await awardXP({
        db: getAdminClient(),
        studentId: userId,
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

// --- Hook 8: Plan Task Complete XP ---
export function xpHookForPlanTaskComplete(params: AfterWriteParams): void {
  const { row, userId, updatedFields } = params;
  if (params.action !== "update") return;
  if (!updatedFields?.includes("status")) return;
  if (row.status !== "completed") return;

  (async () => {
    try {
      const db = getAdminClient();
      const taskId = row.id as string;
      const planId = row.study_plan_id as string;

      if (!planId) {
        const { data: task } = await db
          .from("study_plan_tasks")
          .select("study_plan_id")
          .eq("id", taskId)
          .single();
        if (!task?.study_plan_id) return;
        await _awardPlanTaskXP(db, userId, taskId, task.study_plan_id as string);
        return;
      }

      await _awardPlanTaskXP(db, userId, taskId, planId);
    } catch (e) {
      console.warn("[XP Hook] plan task complete error:", (e as Error).message);
    }
  })();
}

async function _awardPlanTaskXP(
  db: ReturnType<typeof getAdminClient>,
  userId: string,
  taskId: string,
  planId: string,
): Promise<void> {
  const { data: plan } = await db
    .from("study_plans")
    .select("course_id")
    .eq("id", planId)
    .single();

  if (!plan?.course_id) return;

  const { data: course } = await db
    .from("courses")
    .select("institution_id")
    .eq("id", plan.course_id)
    .single();

  if (!course?.institution_id) return;
  const institutionId = course.institution_id as string;

  const bonus = await getBonusContext(userId);

  await awardXP({
    db,
    studentId: userId,
    institutionId,
    action: "complete_plan_task",
    xpBase: XP_TABLE.complete_plan_task,
    sourceType: "plan_task",
    sourceId: taskId,
    currentStreak: bonus.currentStreak,
  });

  try {
    const [totalResult, completedResult] = await Promise.all([
      db
        .from("study_plan_tasks")
        .select("id", { count: "exact", head: true })
        .eq("study_plan_id", planId),
      db
        .from("study_plan_tasks")
        .select("id", { count: "exact", head: true })
        .eq("study_plan_id", planId)
        .eq("status", "completed"),
    ]);

    const totalTasks = totalResult.count ?? 0;
    const completedTasks = completedResult.count ?? 0;

    if (totalTasks > 0 && completedTasks >= totalTasks) {
      console.log(
        `[XP Hook] All ${totalTasks} tasks completed in plan ${planId}! Awarding plan bonus.`,
      );

      await awardXP({
        db,
        studentId: userId,
        institutionId,
        action: "complete_plan",
        xpBase: XP_TABLE.complete_plan,
        sourceType: "study_plan",
        sourceId: planId,
        currentStreak: bonus.currentStreak,
      });

      await db
        .from("study_plans")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", planId)
        .neq("status", "completed");
    }
  } catch (e) {
    console.warn(
      "[XP Hook] Plan completion check error:",
      (e as Error).message,
    );
  }
}
