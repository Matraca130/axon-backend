/**
 * lib/scheduling-intelligence/momentum.ts — Study momentum computation
 *
 * Computes a student's study momentum based on recent activity:
 *   - Session frequency (last 14 days)
 *   - Review accuracy trend
 *   - Streak data
 *
 * Returns a score (0-100), trend, and current streak.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";

export interface MomentumResult {
  score: number;
  trend: "rising" | "stable" | "falling";
  streak: number;
}

/**
 * Compute study momentum for a student.
 *
 * Algorithm:
 *   1. Count study sessions in the last 7 and 14 days
 *   2. Get review accuracy (correct / total) in last 14 days
 *   3. Get current streak from student_xp table
 *   4. Score = weighted combination: 40% frequency + 30% accuracy + 30% streak
 *   5. Trend = compare last-7-days sessions vs prior-7-days sessions
 */
export async function computeStudyMomentum(
  db: SupabaseClient,
  userId: string,
): Promise<MomentumResult> {
  const now = new Date();
  const d7 = new Date(now);
  d7.setDate(d7.getDate() - 7);
  const d14 = new Date(now);
  d14.setDate(d14.getDate() - 14);

  const iso7 = d7.toISOString();
  const iso14 = d14.toISOString();

  // 1. Count sessions in last 7 and last 14 days
  // Reviews are RLS-scoped through study_sessions (no direct student_id column).
  // study_sessions has student_id. Reviews use grade (1=Again,2=Hard,3=Good,4=Easy).
  const [sessionsLast7, sessionsLast14, reviewStats, streakData] =
    await Promise.all([
      db
        .from("study_sessions")
        .select("id", { count: "exact", head: true })
        .eq("student_id", userId)
        .gte("created_at", iso7),
      db
        .from("study_sessions")
        .select("id", { count: "exact", head: true })
        .eq("student_id", userId)
        .gte("created_at", iso14),
      db
        .from("reviews")
        .select("grade")
        .gte("created_at", iso14),
      db
        .from("student_xp")
        .select("current_streak")
        .eq("user_id", userId)
        .limit(1)
        .single(),
    ]);

  const countLast7 = sessionsLast7.count ?? 0;
  const countLast14 = sessionsLast14.count ?? 0;
  const countPrior7 = countLast14 - countLast7;

  // 2. Review accuracy (grade >= 3 = correct: Good/Easy)
  const reviews = reviewStats.data ?? [];
  const totalReviews = reviews.length;
  const correctReviews = reviews.filter(
    (r: { grade: number }) => r.grade >= 3,
  ).length;
  const accuracy = totalReviews > 0 ? correctReviews / totalReviews : 0;

  // 3. Streak
  const streak = streakData.data?.current_streak ?? 0;

  // 4. Score calculation
  // Frequency: 1 session/day = 100%, cap at 2/day
  const freqScore = Math.min((countLast7 / 7) * 100, 100);
  // Accuracy: direct percentage
  const accScore = accuracy * 100;
  // Streak: 7-day streak = 100%, cap at 30 days
  const streakScore = Math.min((streak / 7) * 100, 100);

  const score = Math.round(freqScore * 0.4 + accScore * 0.3 + streakScore * 0.3);

  // 5. Trend
  let trend: "rising" | "stable" | "falling";
  if (countLast7 > countPrior7 + 1) {
    trend = "rising";
  } else if (countLast7 < countPrior7 - 1) {
    trend = "falling";
  } else {
    trend = "stable";
  }

  return { score: Math.min(score, 100), trend, streak };
}
