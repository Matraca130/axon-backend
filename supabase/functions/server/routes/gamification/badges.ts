/**
 * routes/gamification/badges.ts -- Badge system & notifications
 *
 * Endpoints:
 *   GET  /gamification/badges         -- All badge definitions + student's earned
 *   POST /gamification/check-badges    -- Evaluate and award eligible badges
 *   GET  /gamification/notifications   -- Recent gamification events timeline
 *
 * PR #109: POST /check-badges now delegates to badge-engine.ts (DRY)
 * PR #110: GET /badges includes tier + achievement_group
 * BUG-3 FIX: GET /notifications uses `created_at` (correct column)
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import { evaluateAndAwardBadges } from "../../badge-engine.ts";

export const badgeRoutes = new Hono();

// --- GET /gamification/badges ---

badgeRoutes.get(`${PREFIX}/gamification/badges`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const category = c.req.query("category");

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

  const earnedMap = new Map<string, string>();
  if (earnedResult.data) {
    for (const badge of earnedResult.data) {
      earnedMap.set(badge.badge_id, badge.created_at);
    }
  }

  // PR #110: Include tier + achievement_group in response
  const badges = (defsResult.data ?? []).map((def: Record<string, unknown>) => ({
    ...def,
    earned: earnedMap.has(def.id as string),
    earned_at: earnedMap.get(def.id as string) ?? null,
  }));

  // Group by achievement_group for frontend tier display
  const achievementGroups: Record<string, Array<Record<string, unknown>>> = {};
  for (const badge of badges) {
    const group = (badge.achievement_group as string) ?? "standalone";
    if (!achievementGroups[group]) achievementGroups[group] = [];
    achievementGroups[group].push(badge);
  }

  return ok(c, {
    badges,
    total: badges.length,
    earned_count: earnedMap.size,
    achievement_groups: achievementGroups,
  });
});

// --- POST /gamification/check-badges ---
// PR #109: Delegates to badge-engine.ts (was 60 lines of inline logic)

badgeRoutes.post(`${PREFIX}/gamification/check-badges`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const adminDb = getAdminClient();

  try {
    const result = await evaluateAndAwardBadges(
      adminDb,
      db,
      user.id,
      institutionId,
      false, // Don't skip XP award for manual check
    );

    return ok(c, result);
  } catch (e) {
    return err(c, `Badge evaluation failed: ${(e as Error).message}`, 500);
  }
});

// --- GET /gamification/notifications ---

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

  const [xpResult, badgeResult] = await Promise.all([
    db
      .from("xp_transactions")
      .select("id, action, xp_final, bonus_type, created_at")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("student_badges")
      .select("badge_id, created_at, badge_definitions(name, slug, icon_url, rarity, tier, achievement_group)")
      .eq("student_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  const notifications: Array<Record<string, unknown>> = [];

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

  if (badgeResult.data) {
    for (const badge of badgeResult.data) {
      const def = badge.badge_definitions as Record<string, unknown> | null;
      notifications.push({
        type: "badge",
        badge_id: badge.badge_id,
        badge_name: def?.name ?? "Unknown",
        badge_slug: def?.slug ?? null,
        badge_icon: def?.icon_url ?? null,
        badge_rarity: def?.rarity ?? null,
        badge_tier: def?.tier ?? "none",
        achievement_group: def?.achievement_group ?? null,
        timestamp: badge.created_at,
      });
    }
  }

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
