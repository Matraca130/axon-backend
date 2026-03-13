/**
 * routes/gamification/profile.ts -- XP profile, leaderboard & insights
 *
 * Endpoints:
 *   GET /gamification/profile      -- Composite XP + streak + badge count
 *   GET /gamification/xp-history    -- Paginated XP transactions
 *   GET /gamification/leaderboard   -- Weekly/daily leaderboard
 *   GET /gamification/insights      -- Weekly progress summary (Sprint 2)
 *
 * All endpoints require authentication.
 * institution_id is required as query param for XP-scoped data.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";

export const profileRoutes = new Hono();

// --- GET /gamification/profile ---

profileRoutes.get(`${PREFIX}/gamification/profile`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const [xpResult, statsResult, badgeCountResult] = await Promise.all([
    db
      .from("student_xp")
      .select("*")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .maybeSingle(),
    db
      .from("student_stats")
      .select("current_streak, longest_streak, last_study_date")
      .eq("student_id", user.id)
      .maybeSingle(),
    db
      .from("student_badges")
      .select("id", { count: "exact", head: true })
      .eq("student_id", user.id),
  ]);

  if (xpResult.error) {
    return err(c, `Profile fetch failed: ${xpResult.error.message}`, 500);
  }

  const xp = xpResult.data;
  const stats = statsResult.data;
  const badgeCount = badgeCountResult.count ?? 0;

  return ok(c, {
    xp: {
      total: xp?.total_xp ?? 0,
      today: xp?.xp_today ?? 0,
      this_week: xp?.xp_this_week ?? 0,
      level: xp?.current_level ?? 1,
      daily_goal: xp?.daily_goal ?? 50,
      daily_cap: 500,
      streak_freezes_owned: xp?.streak_freezes_owned ?? 0,
    },
    streak: {
      current: stats?.current_streak ?? 0,
      longest: stats?.longest_streak ?? 0,
      last_study_date: stats?.last_study_date ?? null,
    },
    badges_earned: badgeCount,
  });
});

// --- GET /gamification/xp-history ---

profileRoutes.get(`${PREFIX}/gamification/xp-history`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  let limit = parseInt(c.req.query("limit") ?? "50", 10);
  let offset = parseInt(c.req.query("offset") ?? "0", 10);
  if (isNaN(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;
  if (isNaN(offset) || offset < 0) offset = 0;

  const { data, count, error } = await db
    .from("xp_transactions")
    .select("*", { count: "exact" })
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return err(c, `XP history failed: ${error.message}`, 500);
  return ok(c, { items: data, total: count, limit, offset });
});

// --- GET /gamification/leaderboard ---

profileRoutes.get(`${PREFIX}/gamification/leaderboard`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const period = c.req.query("period") ?? "weekly";
  let limit = parseInt(c.req.query("limit") ?? "20", 10);
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;

  let data: unknown[] | null = null;
  let fetchError: { message: string } | null = null;

  if (period === "weekly") {
    const result = await db
      .from("leaderboard_weekly")
      .select("*")
      .eq("institution_id", institutionId)
      .order("xp_this_week", { ascending: false })
      .limit(limit);
    data = result.data;
    fetchError = result.error;

    if (fetchError) {
      const fallback = await db
        .from("student_xp")
        .select("student_id, xp_this_week, current_level, total_xp")
        .eq("institution_id", institutionId)
        .order("xp_this_week", { ascending: false })
        .limit(limit);
      data = fallback.data;
      fetchError = fallback.error;
    }
  } else {
    const result = await db
      .from("student_xp")
      .select("student_id, xp_today, current_level, total_xp")
      .eq("institution_id", institutionId)
      .order("xp_today", { ascending: false })
      .limit(limit);
    data = result.data;
    fetchError = result.error;
  }

  if (fetchError) {
    return err(c, `Leaderboard failed: ${fetchError.message}`, 500);
  }

  const entries = (data ?? []) as Array<Record<string, unknown>>;
  const myIndex = entries.findIndex((e) => e.student_id === user.id);

  return ok(c, { leaderboard: entries, my_rank: myIndex >= 0 ? myIndex + 1 : null, period });
});

// --- GET /gamification/insights (Sprint 2) ---
// Weekly progress summary with personalized tips.

profileRoutes.get(`${PREFIX}/gamification/insights`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoISO = weekAgo.toISOString();

  // Parallel fetch all weekly data
  const [
    xpResult,
    statsResult,
    xpTxResult,
    badgesThisWeek,
    challengesCompleted,
    sessionsThisWeek,
  ] = await Promise.all([
    db
      .from("student_xp")
      .select("total_xp, xp_this_week, current_level, daily_goal")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .maybeSingle(),
    db
      .from("student_stats")
      .select("current_streak, longest_streak, total_reviews, total_sessions")
      .eq("student_id", user.id)
      .maybeSingle(),
    // XP earned per day this week
    db
      .from("xp_transactions")
      .select("xp_final, created_at")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .gte("created_at", weekAgoISO)
      .order("created_at", { ascending: true }),
    // Badges earned this week
    db
      .from("student_badges")
      .select("badge_id", { count: "exact", head: true })
      .eq("student_id", user.id)
      .gte("created_at", weekAgoISO),
    // Challenges completed this week
    db
      .from("student_challenges")
      .select("id", { count: "exact", head: true })
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .not("completed_at", "is", null)
      .gte("completed_at", weekAgoISO),
    // Study sessions this week
    db
      .from("study_sessions")
      .select("id, duration_seconds", { count: "exact" })
      .eq("student_id", user.id)
      .gte("created_at", weekAgoISO)
      .not("completed_at", "is", null),
  ]);

  // Build daily XP breakdown
  const dailyXp: Record<string, number> = {};
  if (xpTxResult.data) {
    for (const tx of xpTxResult.data) {
      const day = (tx.created_at as string).split("T")[0];
      dailyXp[day] = (dailyXp[day] ?? 0) + ((tx.xp_final as number) ?? 0);
    }
  }

  // Calculate total study time this week
  let totalStudyMinutes = 0;
  if (sessionsThisWeek.data) {
    for (const s of sessionsThisWeek.data) {
      totalStudyMinutes += ((s.duration_seconds as number) ?? 0) / 60;
    }
  }
  totalStudyMinutes = Math.round(totalStudyMinutes);

  // Generate personalized tips
  const tips: string[] = [];
  const xpWeek = xpResult.data?.xp_this_week ?? 0;
  const streak = statsResult.data?.current_streak ?? 0;
  const dailyGoal = xpResult.data?.daily_goal ?? 50;

  if (streak === 0) {
    tips.push("Empieza una racha de estudio hoy. La constancia es clave para el aprendizaje.");
  } else if (streak >= 7) {
    tips.push(`Llevas ${streak} dias seguidos. Considera comprar un streak freeze para proteger tu racha.`);
  }

  if ((xpWeek as number) < dailyGoal * 3) {
    tips.push("Intenta estudiar un poco cada dia. Sesiones cortas pero frecuentes son mas efectivas.");
  } else if ((xpWeek as number) >= dailyGoal * 7) {
    tips.push("Excelente semana! Mantener este ritmo te llevara a dominar el material rapido.");
  }

  if ((challengesCompleted.count ?? 0) === 0) {
    tips.push("Completa desafios diarios para ganar XP extra y mantenerte motivado.");
  }

  return ok(c, {
    period: "weekly",
    xp: {
      total: xpResult.data?.total_xp ?? 0,
      this_week: xpWeek,
      level: xpResult.data?.current_level ?? 1,
      daily_goal: dailyGoal,
      daily_breakdown: dailyXp,
    },
    streak: {
      current: streak,
      longest: statsResult.data?.longest_streak ?? 0,
    },
    activity: {
      sessions_completed: sessionsThisWeek.count ?? 0,
      total_study_minutes: totalStudyMinutes,
      challenges_completed: challengesCompleted.count ?? 0,
      badges_earned: badgesThisWeek.count ?? 0,
    },
    tips,
  });
});
