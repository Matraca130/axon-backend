/**
 * routes/schedule/exam-prep.ts — Exam prep panel endpoint
 *
 * GET /schedule/exam-prep/:examId
 *   Returns exam preparation data for a specific exam event:
 *   - Exam details (title, date, course)
 *   - Days remaining until exam
 *   - Forced-due flashcards from exam_schedules
 *   - Topic mastery breakdown for the exam's course
 *   - Suggested daily review load
 *
 * Used by: ExamPrepPanel component.
 *
 * Phase 1 — Deploy endpoints
 * FILE: supabase/functions/server/routes/schedule/exam-prep.ts
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";

export const examPrepRoutes = new Hono();

// ─── GET /schedule/exam-prep/:examId ───────────────────────────

examPrepRoutes.get(`${PREFIX}/schedule/exam-prep/:examId`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const examId = c.req.param("examId");
  if (!isUuid(examId)) return err(c, "Invalid exam ID", 400);

  // 1. Fetch the exam event and verify ownership
  const { data: exam, error: examErr } = await db
    .from("exam_events")
    .select("id, student_id, course_id, institution_id, title, date, time, location, is_final, exam_type, created_at")
    .eq("id", examId)
    .maybeSingle();

  if (examErr) {
    console.error(`[exam-prep] exam lookup error: ${examErr.message}`);
    return err(c, "Failed to lookup exam event", 500);
  }
  if (!exam) return err(c, "Exam event not found", 404);
  if (exam.student_id !== user.id) return err(c, "Not authorized", 403);

  // 2. Days remaining
  const examDate = new Date(exam.date + "T00:00:00Z");
  const now = new Date();
  const daysRemaining = Math.max(
    0,
    Math.ceil((examDate.getTime() - now.getTime()) / 86400000),
  );

  // 3. Fetch forced-due flashcards from exam_schedules
  const { data: schedules, error: schedErr } = await db
    .from("exam_schedules")
    .select("id, flashcard_id, forced_due_at, original_due_at, priority_weight, reason")
    .eq("exam_event_id", examId)
    .order("forced_due_at", { ascending: true });

  if (schedErr) {
    console.error(`[exam-prep] schedules error: ${schedErr.message}`);
  }

  const scheduledCards = schedules ?? [];

  // 4. Fetch course topic mastery for this student
  const { data: mastery, error: masteryErr } = await db
    .from("flashcards")
    .select("topic_id, stability, difficulty, state")
    .eq("student_id", user.id)
    .eq("course_id", exam.course_id);

  if (masteryErr) {
    console.error(`[exam-prep] mastery error: ${masteryErr.message}`);
  }

  // Aggregate mastery by topic
  const topicMap = new Map<string, { total: number; mastered: number; learning: number; new: number }>();
  if (mastery) {
    for (const card of mastery) {
      const tid = card.topic_id ?? "unknown";
      if (!topicMap.has(tid)) {
        topicMap.set(tid, { total: 0, mastered: 0, learning: 0, new: 0 });
      }
      const t = topicMap.get(tid)!;
      t.total++;
      // FSRS states: 0=New, 1=Learning, 2=Review, 3=Relearning
      if (card.state === 2 && (card.stability ?? 0) > 10) {
        t.mastered++;
      } else if (card.state === 0) {
        t.new++;
      } else {
        t.learning++;
      }
    }
  }

  const topicMastery = Array.from(topicMap.entries()).map(([topicId, stats]) => ({
    topicId,
    total: stats.total,
    mastered: stats.mastered,
    learning: stats.learning,
    new: stats.new,
    masteryPercent: stats.total > 0
      ? Math.round((stats.mastered / stats.total) * 100)
      : 0,
  }));

  // 5. Suggested daily review load
  const totalCards = scheduledCards.length;
  const suggestedDailyLoad = daysRemaining > 0
    ? Math.ceil(totalCards / daysRemaining)
    : totalCards;

  return ok(c, {
    exam: {
      id: exam.id,
      title: exam.title,
      date: exam.date,
      time: exam.time,
      location: exam.location,
      isFinal: exam.is_final,
      examType: exam.exam_type,
      courseId: exam.course_id,
      institutionId: exam.institution_id,
    },
    daysRemaining,
    scheduledCards: scheduledCards.length,
    cards: scheduledCards,
    topicMastery,
    suggestedDailyLoad,
    totalFlashcards: mastery?.length ?? 0,
  });
});
