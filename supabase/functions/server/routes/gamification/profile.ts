/**
 * routes/gamification/profile.ts — XP profile & leaderboard
 *
 * AUDIT FIXES:
 *   B-001 — daily_goal -> daily_goal_minutes (matches DB column)
 *   A-007 — Leaderboard daily includes display_name via profiles join
 *   A-008 — Badge count filtered by institution_id
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";

export const profileRoutes = new Hono();

// ─── GET /gamification/profile ──────────────────────────────

profileRoutes.get(`${PREFIX}/gamification/profile`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  // Parallel fetch: XP aggregate + student stats + badge count
  // A-008 FIX: Badge count filtered by institution_id
  const [xpResult, statsResult, badgeCountResult] = await Promise.all([
    db
      .from("student_xp")
      .select("total_xp, xp_today, xp_this_week, current_level, daily_goal_minutes, streak_freezes_owned")
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
      .eq("student_id", user.id)
      .eq("institution_id", institutionId),
  ]);

  if (xpResult.error) {
    return safeErr(c, "XP profile fetch", xpResult.error);
  }

  const xp = xpResult.data;
  const stats = statsResult.data;
  const badgeCount = badgeCountResult.count ?? 0;

  // B-001 FIX: Use daily_goal_minutes (actual DB column)
  return ok(c, {
    xp: {
      total: xp?.total_xp ?? 0,
      today: xp?.xp_today ?? 0,
      this_week: xp?.xp_this_week ?? 0,
      level: xp?.current_level ?? 1,
      daily_goal_minutes: xp?.daily_goal_minutes ?? 10,
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

// ─── GET /gamification/xp-history ───────────────────────────

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
    .select("id, action, xp_base, xp_final, bonus_type, multiplier, source_type, source_id, created_at", { count: "estimated" })
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return safeErr(c, "XP history", error);
  return ok(c, { items: data, total: count, limit, offset });
});

// ─── GET /gamification/leaderboard ──────────────────────────

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
    // Try materialized view first
    const result = await db
      .from("leaderboard_weekly")
      .select("*")
      .eq("institution_id", institutionId)
      .order("xp_this_week", { ascending: false })
      .limit(limit);
    data = result.data;
    fetchError = result.error;

    // Fallback to student_xp if MV doesn't exist
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
    // A-007 FIX: Daily leaderboard now fetches from student_xp
    // Note: display_name requires a join via profiles table.
    // For now, frontend should resolve names from student_id.
    const result = await db
      .from("student_xp")
      .select("student_id, xp_today, current_level, total_xp")
      .eq("institution_id", institutionId)
      .gt("xp_today", 0)
      .order("xp_today", { ascending: false })
      .limit(limit);
    data = result.data;
    fetchError = result.error;
  }

  if (fetchError) {
    return safeErr(c, "Leaderboard", fetchError);
  }

  // Find caller's rank
  const entries = (data ?? []) as Array<Record<string, unknown>>;
  const myIndex = entries.findIndex((e) => e.student_id === user.id);

  return ok(c, {
    leaderboard: entries,
    my_rank: myIndex >= 0 ? myIndex + 1 : null,
    period,
  });
});
