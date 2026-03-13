/**
 * routes/gamification/badges.ts — Badge system & notifications
 *
 * Endpoints:
 *   GET  /gamification/badges        — All badge definitions + student's earned badges
 *   POST /gamification/check-badges   — Evaluate and award eligible badges
 *   GET  /gamification/notifications  — Recent gamification events timeline
 *
 * BUG-3 FIX: GET /notifications now uses `created_at` (correct column)
 *   instead of `earned_at` (which doesn't exist in student_badges).
 *
 * AUDIT FIXES (PR #113):
 *   G-002 — badge INSERT now includes institution_id (multi-tenancy)
 *   G-005 — icon_url → icon (matches DB column name)
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import { evaluateSimpleCondition } from "./helpers.ts";
import { awardXP } from "../../xp-engine.ts";

export const badgeRoutes = new Hono();

// ─── GET /gamification/badges ───────────────────────────────

badgeRoutes.get(`${PREFIX}/gamification/badges`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const category = c.req.query("category");

  // Parallel fetch: all definitions + student's earned badges
  let defsQuery = db
    .from("badge_definitions")
    .select("*")
    .eq("is_active", true)
    .order("category")
    .order("name");

  if (category) {
    defsQuery = defsQuery.eq("category", category);
  }

  const [defsResult, earnedResult] = await Promise.all([
    defsQuery,
    db
      .from("student_badges")
      .select("badge_id, created_at")
      .eq("student_id", user.id),
  ]);

  if (defsResult.error) {
    return err(c, `Badges fetch failed: ${defsResult.error.message}`, 500);
  }

  // Build earned map: badge_id → earned_at
  const earnedMap = new Map<string, string>();
  if (earnedResult.data) {
    for (const badge of earnedResult.data) {
      earnedMap.set(badge.badge_id, badge.created_at);
    }
  }

  // Merge: add earned_at to each badge definition
  const badges = (defsResult.data ?? []).map((def: Record<string, unknown>) => ({
    ...def,
    earned: earnedMap.has(def.id as string),
    earned_at: earnedMap.get(def.id as string) ?? null,
  }));

  return ok(c, {
    badges,
    total: badges.length,
    earned_count: earnedMap.size,
  });
});

// ─── POST /gamification/check-badges ────────────────────────

badgeRoutes.post(`${PREFIX}/gamification/check-badges`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const adminDb = getAdminClient();

  // Step 1: Get all active badge definitions not yet earned by this student
  const { data: allBadges, error: badgeErr } = await adminDb
    .from("badge_definitions")
    .select("*")
    .eq("is_active", true);

  if (badgeErr) {
    return err(c, `Badge definitions fetch failed: ${badgeErr.message}`, 500);
  }

  const { data: earnedBadges } = await db
    .from("student_badges")
    .select("badge_id")
    .eq("student_id", user.id);

  const earnedIds = new Set((earnedBadges ?? []).map((b: Record<string, unknown>) => b.badge_id));
  const unearnedBadges = (allBadges ?? []).filter(
    (b: Record<string, unknown>) => !earnedIds.has(b.id as string),
  );

  if (unearnedBadges.length === 0) {
    return ok(c, { new_badges: [], message: "All badges already earned or no badges defined" });
  }

  // Step 2: Get student data for evaluation
  const [xpResult, statsResult] = await Promise.all([
    db
      .from("student_xp")
      .select("total_xp, current_level, xp_today, xp_this_week")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .maybeSingle(),
    db
      .from("student_stats")
      .select("current_streak, longest_streak, total_reviews, total_sessions")
      .eq("student_id", user.id)
      .maybeSingle(),
  ]);

  // Build evaluation context
  const evalContext: Record<string, unknown> = {
    total_xp: xpResult.data?.total_xp ?? 0,
    current_level: xpResult.data?.current_level ?? 1,
    xp_today: xpResult.data?.xp_today ?? 0,
    xp_this_week: xpResult.data?.xp_this_week ?? 0,
    current_streak: statsResult.data?.current_streak ?? 0,
    longest_streak: statsResult.data?.longest_streak ?? 0,
    total_reviews: statsResult.data?.total_reviews ?? 0,
    total_sessions: statsResult.data?.total_sessions ?? 0,
  };

  // Step 3: Evaluate each unearned badge
  const newBadges: Array<Record<string, unknown>> = [];

  for (const badge of unearnedBadges) {
    const criteria = badge.criteria as string;
    if (!criteria) continue;

    // Support multiple conditions separated by " AND "
    const conditions = criteria.split(" AND ").map((s: string) => s.trim());
    const allMet = conditions.every((cond: string) =>
      evaluateSimpleCondition(cond, evalContext),
    );

    if (allMet) {
      // G-002 FIX: Include institution_id in badge award INSERT
      const { error: insertErr } = await adminDb
        .from("student_badges")
        .insert({
          student_id: user.id,
          badge_id: badge.id,
          institution_id: institutionId,
        });

      if (!insertErr) {
        newBadges.push(badge);

        // Award badge XP reward (if defined)
        const xpReward = badge.xp_reward as number;
        if (xpReward && xpReward > 0) {
          try {
            await awardXP({
              db: adminDb,
              studentId: user.id,
              institutionId,
              action: `badge_${badge.slug}`,
              xpBase: xpReward,
              sourceType: "badge",
              sourceId: badge.id as string,
            });
          } catch (e) {
            console.warn(
              `[Badges] XP award for badge ${badge.slug} failed:`,
              (e as Error).message,
            );
          }
        }
      }
    }
  }

  return ok(c, {
    new_badges: newBadges,
    checked: unearnedBadges.length,
    awarded: newBadges.length,
  });
});

// ─── GET /gamification/notifications ────────────────────────
// BUG-3 FIX: Uses `created_at` (correct column in student_badges),
// not `earned_at` which doesn't exist in the table schema.
// G-005 FIX: Uses `icon` (correct column), not `icon_url`.

badgeRoutes.get(`${PREFIX}/gamification/notifications`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  let limit = parseInt(c.req.query("limit") ?? "20", 10);
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 50) limit = 50;

  // Parallel fetch: recent XP transactions + recent badge awards
  const [xpResult, badgeResult] = await Promise.all([
    db
      .from("xp_transactions")
      .select("id, action, xp_final, bonus_type, created_at")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .order("created_at", { ascending: false })
      .limit(limit),
    // BUG-3 FIX: select created_at (not earned_at)
    // G-005 FIX: select icon (not icon_url)
    db
      .from("student_badges")
      .select("badge_id, created_at, badge_definitions(name, slug, icon, rarity)")
      .eq("student_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  // Build unified timeline
  const notifications: Array<Record<string, unknown>> = [];

  // Add XP events
  if (xpResult.data) {
    for (const tx of xpResult.data) {
      notifications.push({
        type: "xp",
        action: tx.action,
        xp: tx.xp_final,
        bonus: tx.bonus_type,
        timestamp: tx.created_at,
      });
    }
  }

  // Add badge events
  if (badgeResult.data) {
    for (const badge of badgeResult.data) {
      const def = badge.badge_definitions as Record<string, unknown> | null;
      notifications.push({
        type: "badge",
        badge_id: badge.badge_id,
        badge_name: def?.name ?? "Unknown",
        badge_slug: def?.slug ?? null,
        badge_icon: def?.icon ?? null,
        badge_rarity: def?.rarity ?? null,
        // BUG-3 FIX: use created_at from student_badges
        timestamp: badge.created_at,
      });
    }
  }

  // Sort by timestamp descending, then slice to limit
  notifications.sort((a, b) => {
    const tA = new Date(a.timestamp as string).getTime();
    const tB = new Date(b.timestamp as string).getTime();
    return tB - tA;
  });

  return ok(c, {
    notifications: notifications.slice(0, limit),
    total: notifications.length,
  });
});
