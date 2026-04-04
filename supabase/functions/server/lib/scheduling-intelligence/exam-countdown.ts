/**
 * lib/scheduling-intelligence/exam-countdown.ts — Exam prep countdown planner
 *
 * Given an exam event, generates a prioritized review plan
 * based on FSRS states and topic difficulty.
 *
 * Returns an array of ExamReviewPlan items sorted by priority.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";

export interface ExamReviewPlan {
  topicName: string;
  topicId: string;
  difficulty: number;
  peakRetrievability: number;
  reviewDates: string[];
  priority: number;
}

/**
 * Plan an exam countdown review schedule.
 *
 * Algorithm:
 *   1. Load the exam event to get course_id and date
 *   2. Find all topics in that course
 *   3. For each topic, get FSRS states of associated flashcards
 *   4. Compute priority = (1 - avg retrievability) * difficulty weight
 *   5. Generate review dates spread between now and exam date
 */
export async function planExamCountdown(
  db: SupabaseClient,
  userId: string,
  examId: string,
): Promise<ExamReviewPlan[]> {
  // 1. Load exam event
  const { data: exam, error: examErr } = await db
    .from("exam_events")
    .select("id, course_id, date, title")
    .eq("id", examId)
    .eq("student_id", userId)
    .single();

  if (examErr || !exam) {
    return [];
  }

  const examDate = new Date(exam.date);
  const now = new Date();
  const daysUntilExam = Math.max(
    1,
    Math.ceil((examDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
  );

  // 2. Find topics for this course (through semesters → sections → topics)
  const { data: topics } = await db
    .from("topics")
    .select(`
      id, name,
      sections!inner(
        id,
        semesters!inner(
          id,
          course_id
        )
      )
    `)
    .eq("sections.semesters.course_id", exam.course_id)
    .eq("is_active", true);

  if (!topics || topics.length === 0) {
    return [];
  }

  // 3. Get FSRS states for flashcards belonging to these topics
  // Path: topics → keywords (topic_id) → flashcards (keyword_id) → fsrs_states (flashcard_id)
  const topicIds = topics.map((t: { id: string }) => t.id);

  const { data: fsrsData } = await db
    .from("fsrs_states")
    .select("flashcard_id, stability, difficulty, retrievability, flashcards!inner(keyword_id, keywords!inner(topic_id))")
    .in("flashcards.keywords.topic_id", topicIds)
    .eq("student_id", userId);

  // Group FSRS states by topic
  const topicStats: Record<string, { totalR: number; totalD: number; count: number }> = {};
  for (const row of fsrsData ?? []) {
    // deno-lint-ignore no-explicit-any
    const fc = (row as any).flashcards;
    const kw = fc?.keywords;
    const topicId: string | undefined = kw?.topic_id;
    if (!topicId) continue;
    if (!topicStats[topicId]) {
      topicStats[topicId] = { totalR: 0, totalD: 0, count: 0 };
    }
    topicStats[topicId].totalR += row.retrievability ?? 0.5;
    topicStats[topicId].totalD += row.difficulty ?? 5;
    topicStats[topicId].count += 1;
  }

  // 4. Build review plans
  const plans: ExamReviewPlan[] = [];

  for (const topic of topics) {
    const t = topic as { id: string; name: string };
    const stats = topicStats[t.id];
    const avgR = stats ? stats.totalR / stats.count : 0.5;
    const avgD = stats ? stats.totalD / stats.count : 5;

    // Priority: lower retrievability + higher difficulty = higher priority
    const priority = Math.round(((1 - avgR) * 50 + (avgD / 10) * 50) * 100) / 100;

    // Generate review dates: spread reviews based on priority
    const numReviews = Math.min(Math.max(Math.ceil(priority / 20), 1), daysUntilExam);
    const reviewDates: string[] = [];
    const interval = Math.max(1, Math.floor(daysUntilExam / (numReviews + 1)));

    for (let i = 1; i <= numReviews; i++) {
      const reviewDate = new Date(now);
      reviewDate.setDate(reviewDate.getDate() + interval * i);
      if (reviewDate <= examDate) {
        reviewDates.push(reviewDate.toISOString().split("T")[0]);
      }
    }

    plans.push({
      topicName: t.name,
      topicId: t.id,
      difficulty: Math.round(avgD * 100) / 100,
      peakRetrievability: Math.round(avgR * 100) / 100,
      reviewDates,
      priority,
    });
  }

  // Sort by priority descending (highest priority first)
  plans.sort((a, b) => b.priority - a.priority);

  return plans;
}
