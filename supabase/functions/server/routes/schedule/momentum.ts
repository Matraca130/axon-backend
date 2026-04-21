/**
 * routes/schedule/momentum.ts — MomentumCard dashboard endpoint
 *
 * GET /schedule/momentum
 *   Returns today's study momentum data for the authenticated student:
 *   - Tasks completed today vs planned
 *   - Current streak (consecutive days with activity)
 *   - Weekly progress percentage
 *   - Next recommended task
 *
 * Used by: MomentumCard component on the student dashboard.
 *
 * Phase 1 — Deploy endpoints
 * FILE: supabase/functions/server/routes/schedule/momentum.ts
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";

export const momentumRoutes = new Hono();

// ─── GET /schedule/momentum ────────────────────────────────────

momentumRoutes.get(`${PREFIX}/schedule/momentum`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const courseId = c.req.query("course_id");

  try {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

    // 1. Today's completed flashcard reviews
    let todayQuery = db
      .from("flashcard_reviews")
      .select("id", { count: "exact", head: true })
      .eq("student_id", user.id)
      .gte("created_at", `${today}T00:00:00Z`)
      .lte("created_at", `${today}T23:59:59Z`);
    if (courseId) todayQuery = todayQuery.eq("course_id", courseId);

    const { count: completedToday, error: todayErr } = await todayQuery;
    if (todayErr) {
      console.error(`[momentum] today reviews error: ${todayErr.message}`);
      return safeErr(c, "Momentum today reviews", todayErr);
    }

    // 2. Weekly reviews (last 7 days)
    let weekQuery = db
      .from("flashcard_reviews")
      .select("id", { count: "exact", head: true })
      .eq("student_id", user.id)
      .gte("created_at", `${weekAgo}T00:00:00Z`);
    if (courseId) weekQuery = weekQuery.eq("course_id", courseId);

    const { count: weeklyReviews, error: weekErr } = await weekQuery;
    if (weekErr) {
      console.error(`[momentum] weekly reviews error: ${weekErr.message}`);
      return safeErr(c, "Momentum weekly reviews", weekErr);
    }

    // 3. Streak calculation — count consecutive days with at least 1 review
    const { data: recentDays, error: streakErr } = await db
      .from("flashcard_reviews")
      .select("created_at")
      .eq("student_id", user.id)
      .gte("created_at", new Date(Date.now() - 90 * 86400000).toISOString())
      .order("created_at", { ascending: false })
      .limit(500);

    if (streakErr) {
      console.error(`[momentum] streak query error: ${streakErr.message}`);
      return safeErr(c, "Momentum streak query", streakErr);
    }

    let streak = 0;
    if (recentDays && recentDays.length > 0) {
      const uniqueDays = new Set(
        recentDays.map((r: { created_at: string }) =>
          r.created_at.split("T")[0]
        ),
      );
      const sortedDays = Array.from(uniqueDays).sort().reverse();

      // Count consecutive days starting from today or yesterday
      const todayStr = today;
      const yesterdayStr = new Date(Date.now() - 86400000)
        .toISOString()
        .split("T")[0];

      if (sortedDays[0] === todayStr || sortedDays[0] === yesterdayStr) {
        streak = 1;
        for (let i = 1; i < sortedDays.length; i++) {
          const prev = new Date(sortedDays[i - 1]);
          const curr = new Date(sortedDays[i]);
          const diffMs = prev.getTime() - curr.getTime();
          if (diffMs <= 86400000 + 1000) {
            // ~1 day tolerance
            streak++;
          } else {
            break;
          }
        }
      }
    }

    // 4. Flashcards due today (upcoming workload)
    let dueQuery = db
      .from("flashcards")
      .select("id", { count: "exact", head: true })
      .eq("student_id", user.id)
      .lte("next_review_at", `${today}T23:59:59Z`);
    if (courseId) dueQuery = dueQuery.eq("course_id", courseId);

    const { count: dueToday, error: dueErr } = await dueQuery;
    if (dueErr) {
      console.error(`[momentum] due cards error: ${dueErr.message}`);
      return safeErr(c, "Momentum due cards", dueErr);
    }

    // 5. Weekly goal progress — estimate based on daily target of 20 reviews
    const dailyTarget = 20;
    const weeklyTarget = dailyTarget * 7;
    const weeklyProgress = Math.min(
      100,
      Math.round(((weeklyReviews ?? 0) / weeklyTarget) * 100),
    );

    return ok(c, {
      completedToday: completedToday ?? 0,
      dueToday: dueToday ?? 0,
      streak,
      weeklyReviews: weeklyReviews ?? 0,
      weeklyProgress,
      weeklyTarget,
      date: today,
    });
  } catch (e) {
    console.error(`[momentum] Unexpected error: ${(e as Error).message}`);
    return err(c, "Failed to load momentum data", 500);
  }
});
