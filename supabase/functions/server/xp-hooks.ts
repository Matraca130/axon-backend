/**
 * xp-hooks.ts — afterWrite hooks for XP awarding in Axon v4.4
 *
 * AUDIT FIXES:
 *   G-008 — xpHookForQuizAttempt resolves via quiz_question_id
 *   A-011 — Removed unused summaryId return value
 *   A-013 — Batch review uses shared bonus + per-card only for flashcards
 *   D-4   — student_stats total_reviews/total_sessions now incremented (G-009 fix)
 */

import type { AfterWriteParams } from "./crud-factory.ts";
import { awardXP, XP_TABLE } from "./xp-engine.ts";
import { getAdminClient } from "./db.ts";
import { postAwardEvaluation } from "./gamification-dispatcher.ts";
import { resolveInstitutionViaRpc, resolveInstitutionFromCourse } from "./lib/institution-resolver.ts";

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
    return resolveInstitutionFromCourse(db, session.course_id as string);
  } catch {
    return null;
  }
}

// --- G-008 FIX: Resolve institution from quiz_question_id ---
// A-011 FIX: Only returns institutionId (removed unused summaryId)
async function resolveInstitutionFromQuizQuestion(
  quizQuestionId: string,
): Promise<string | null> {
  const db = getAdminClient();
  try {
    const { data: qq } = await db
      .from("quiz_questions")
      .select("summary_id")
      .eq("id", quizQuestionId)
      .single();
    if (!qq?.summary_id) return null;
    return resolveInstitutionViaRpc(db, "summaries", qq.summary_id as string);
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
          .maybeSingle();
        result.currentStreak = stats?.current_streak ?? 0;
      })(),
    );
    await Promise.all(promises);
  } catch (e) {
    console.warn("[XP Hooks] getBonusContext error:", (e as Error).message);
  }
  return result;
}

// --- D-4 FIX: Increment student_stats counters ---
//
// G-009 resolution: total_reviews and total_sessions are now
// incremented by the relevant XP hooks, enabling badge evaluation
// for review-count and session-count criteria badges.
//
// Uses read-then-write (not atomic RPC) because:
//   - Counters are for badge thresholds (>=1, >=100, >=500)
//   - Off-by-1 from concurrent reviews is irrelevant
//   - Same student reviewing simultaneously is practically impossible
//
// If student_stats row doesn't exist (pre-onboarding), creates it
// with defaults. Failures are non-critical (warn + continue).

async function _incrementStudentStat(
  studentId: string,
  field: "total_reviews" | "total_sessions",
  amount: number = 1,
): Promise<void> {
  const db = getAdminClient();
  try {
    // BH-ERR-016 FIX: Atomic upsert via RPC replaces race-prone SELECT→UPDATE
    const { error } = await db.rpc("increment_student_stat", {
      p_student_id: studentId,
      p_field: field,
      p_amount: amount,
    });
    if (error) throw error;
  } catch (e) {
    // Non-critical: badge evaluation still works, just counters won't update
    console.warn(
      `[XP Hooks] _incrementStudentStat(${field}) failed:`,
      (e as Error).message,
    );
  }
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
        console.warn("[XP Hook] Could not resolve institution for session:", sessionId);
        return;
      }
      const isCorrect = (row.grade as number) >= 3;
      const xpBase = isCorrect ? XP_TABLE.review_correct : XP_TABLE.review_flashcard;
      const flashcardId = row.item_id as string;
      const bonus = await getBonusContext(userId, flashcardId);
      const result = await awardXP({
        db: getAdminClient(),
        studentId: userId,
        institutionId,
        action: isCorrect ? "review_correct" : "review_flashcard",
        xpBase,
        sourceType: "flashcard",
        sourceId: flashcardId,
        ...bonus,
      });
      // D-4: Increment total_reviews for badge criteria evaluation
      await _incrementStudentStat(userId, "total_reviews");
      // Post-award badge evaluation (advisory-lock protected)
      if (result) postAwardEvaluation(userId, institutionId);
    } catch (e) {
      console.warn("[XP Hook] review error:", (e as Error).message);
    }
  })();
}

// --- Hook 2: Quiz Answer XP (G-008 FIX) ---
// Returns a Promise so the caller can register it with `waitUntil`,
// keeping the isolate alive until DB writes complete (issue #688).
export async function xpHookForQuizAttempt(params: AfterWriteParams): Promise<void> {
  const { row, userId } = params;
  if (params.action !== "create") return;
  try {
    const isCorrect = row.is_correct === true;
    const xpBase = isCorrect ? XP_TABLE.quiz_correct : XP_TABLE.quiz_answer;
    const quizQuestionId = row.quiz_question_id as string;
    if (!quizQuestionId) return;
    // A-011 FIX: simplified return (no unused summaryId)
    const institutionId = await resolveInstitutionFromQuizQuestion(quizQuestionId);
    if (!institutionId) {
      console.warn("[XP Hook] Could not resolve institution for quiz_question:", quizQuestionId);
      return;
    }
    const bonus = await getBonusContext(userId);
    const result = await awardXP({
      db: getAdminClient(),
      studentId: userId,
      institutionId,
      action: isCorrect ? "quiz_correct" : "quiz_answer",
      xpBase,
      sourceType: "quiz",
      sourceId: row.id as string,
      currentStreak: bonus.currentStreak,
    });
    // Post-award badge evaluation (advisory-lock protected)
    if (result) postAwardEvaluation(userId, institutionId);
  } catch (e) {
    console.warn("[XP Hook] quiz error:", (e as Error).message);
  }
}

// --- Hook 3: Study Session Complete XP ---
export function xpHookForSessionComplete(params: AfterWriteParams): void {
  const { row, userId, updatedFields } = params;
  if (params.action !== "update") return;
  if (!updatedFields?.includes("completed_at")) return;
  if (!row.completed_at) return;
  (async () => {
    try {
      const institutionId = await resolveInstitutionFromSession(row.id as string);
      if (!institutionId) return;
      const bonus = await getBonusContext(userId);
      const result = await awardXP({
        db: getAdminClient(),
        studentId: userId,
        institutionId,
        action: "complete_session",
        xpBase: XP_TABLE.complete_session,
        sourceType: "session",
        sourceId: row.id as string,
        currentStreak: bonus.currentStreak,
      });
      // D-4: Increment total_sessions for badge criteria evaluation
      await _incrementStudentStat(userId, "total_sessions");
      // Post-award badge evaluation (advisory-lock protected)
      if (result) postAwardEvaluation(userId, institutionId);
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
      const instId = await resolveInstitutionViaRpc(db, "summaries", summaryId);
      if (!instId) return;
      const bonus = await getBonusContext(userId);
      const result = await awardXP({
        db,
        studentId: userId,
        institutionId: instId as string,
        action: "complete_reading",
        xpBase: XP_TABLE.complete_reading,
        sourceType: "reading",
        sourceId: row.id as string,
        currentStreak: bonus.currentStreak,
      });
      // Post-award badge evaluation (advisory-lock protected)
      if (result) postAwardEvaluation(userId, instId as string);
    } catch (e) {
      console.warn("[XP Hook] reading error:", (e as Error).message);
    }
  })();
}

// --- Hook 5: Batch Review XP ---
// A-013 NOTE: Uses shared bonus context to avoid N+1.
// Per-card FSRS/BKT bonus only fetched for flashcard instrument_type.
export function xpHookForBatchReviews(
  userId: string,
  sessionId: string,
  reviews: Array<{ item_id: string; grade: number; instrument_type: string }>,
): void {
  (async () => {
    try {
      const institutionId = await resolveInstitutionFromSession(sessionId);
      if (!institutionId) {
        console.warn("[XP Hook] Could not resolve institution for batch session:", sessionId);
        return;
      }
      const db = getAdminClient();
      // Shared bonus (streak) fetched once for all reviews
      const sharedBonus = await getBonusContext(userId);

      // Process in chunks of 10 to avoid overwhelming DB
      const CHUNK_SIZE = 10;
      for (let i = 0; i < reviews.length; i += CHUNK_SIZE) {
        const chunk = reviews.slice(i, i + CHUNK_SIZE);
        const promises = chunk.map(async (review) => {
          try {
            const isCorrect = review.grade >= 3;
            const xpBase = isCorrect ? XP_TABLE.review_correct : XP_TABLE.review_flashcard;

            // Only fetch per-card bonus for flashcards (FSRS/BKT context)
            let reviewBonus = sharedBonus;
            if (review.instrument_type === "flashcard") {
              try {
                reviewBonus = await getBonusContext(userId, review.item_id);
              } catch { /* fallback to shared */ }
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
          } catch (e) {
            console.warn(`[XP Hook] batch review item ${review.item_id} error:`, (e as Error).message);
          }
        });
        await Promise.all(promises);
      }

      // D-4: Increment total_reviews for badge criteria evaluation
      // Single increment for the whole batch (more efficient than per-review)
      await _incrementStudentStat(userId, "total_reviews", reviews.length);
      // Post-award badge evaluation once for entire batch (advisory-lock protected)
      postAwardEvaluation(userId, institutionId);
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
      const result = await awardXP({
        db: getAdminClient(),
        studentId: userId,
        institutionId,
        action: "complete_video",
        xpBase: XP_TABLE.complete_video,
        sourceType: "video",
        sourceId: videoId,
        currentStreak: bonus.currentStreak,
      });
      // Post-award badge evaluation (advisory-lock protected)
      if (result) postAwardEvaluation(userId, institutionId);
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
      const result = await awardXP({
        db: getAdminClient(),
        studentId: userId,
        institutionId,
        action: "rag_question",
        xpBase: XP_TABLE.rag_question,
        sourceType: "rag_chat",
        sourceId: logId,
        currentStreak: bonus.currentStreak,
      });
      // Post-award badge evaluation (advisory-lock protected)
      if (result) postAwardEvaluation(userId, institutionId);
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

  const taskResult = await awardXP({
    db,
    studentId: userId,
    institutionId,
    action: "complete_plan_task",
    xpBase: XP_TABLE.complete_plan_task,
    sourceType: "plan_task",
    sourceId: taskId,
    currentStreak: bonus.currentStreak,
  });

  // Post-award badge evaluation (advisory-lock protected)
  if (taskResult) postAwardEvaluation(userId, institutionId);

  try {
    const [totalResult, completedResult] = await Promise.all([
      db.from("study_plan_tasks").select("id", { count: "exact", head: true }).eq("study_plan_id", planId),
      db.from("study_plan_tasks").select("id", { count: "exact", head: true }).eq("study_plan_id", planId).eq("status", "completed"),
    ]);
    const totalTasks = totalResult.count ?? 0;
    const completedTasks = completedResult.count ?? 0;
    if (totalTasks > 0 && completedTasks >= totalTasks) {
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
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("id", planId)
        .neq("status", "completed");
    }
  } catch (e) {
    console.warn("[XP Hook] Plan completion check error:", (e as Error).message);
  }
}
