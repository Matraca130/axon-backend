/**
 * routes/gamification/badges.ts — Badge system & notifications
 *
 * AUDIT FIXES:
 *   G-002 — student_badges INSERT includes institution_id
 *   BUG-3 — GET /notifications uses created_at (correct column)
 *   A-001 — icon_url corrected to icon (matches DB column)
 *   A-002 — Sort function dead code removed
 *   A-003 — Badge notifications filtered by institution_id
 *
 * SPRINT 3:
 *   S3-001 — COUNT-based badge evaluation via trigger_config
 *   S3-002 — Parallel Phase 2 with Promise.allSettled
 *            + tryAwardBadge DRY helper with 23505 race handling
 *   S3-004 — Removed ai_conversations & leaderboard_weekly from
 *            ALLOWED_TABLES; 4 badges deactivated (helpers.ts)
 *
 * CONCURRENCY FIX:
 *   C-001 — tryAwardBadge: fresh DB check before insert prevents
 *           double XP when concurrent check-badges requests race
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import {
  evaluateSimpleCondition,
  evaluateCountBadge,
  type TriggerConfig,
} from "./helpers.ts";
import { tryAwardBadge } from "../../lib/badge-award.ts";

export const badgeRoutes = new Hono();

// --- GET /gamification/badges ---
// CROSS-TENANT FIX: require institution_id and filter student_badges by it
// to prevent leaking earned badges across institutions.
badgeRoutes.get(`${PREFIX}/gamification/badges`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

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
      .eq("student_id", user.id)
      .eq("institution_id", institutionId),
  ]);

  if (defsResult.error) {
    return safeErr(c, "Badges fetch", defsResult.error);
  }

  if (earnedResult.error) {
    return safeErr(c, "Earned badges fetch", earnedResult.error);
  }

  const earnedMap = new Map<string, string>();
  if (earnedResult.data) {
    for (const badge of earnedResult.data) {
      earnedMap.set(badge.badge_id, badge.created_at);
    }
  }

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

// --- POST /gamification/check-badges ---
badgeRoutes.post(`${PREFIX}/gamification/check-badges`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const adminDb = getAdminClient();

  const { data: allBadges, error: badgeErr } = await adminDb
    .from("badge_definitions")
    .select("*")
    .eq("is_active", true);

  if (badgeErr) {
    return safeErr(c, "Badge definitions fetch", badgeErr);
  }

  // Scope to the current institution so a badge earned in institution A
  // doesn't block it from being earned in institution B (#289).
  const { data: earnedBadges, error: earnedErr } = await db
    .from("student_badges")
    .select("badge_id")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId);

  if (earnedErr) {
    return safeErr(c, "Earned badges fetch", earnedErr);
  }

  const earnedIds = new Set((earnedBadges ?? []).map((b: Record<string, unknown>) => b.badge_id));
  const unearnedBadges = (allBadges ?? []).filter(
    (b: Record<string, unknown>) => !earnedIds.has(b.id as string),
  );

  if (unearnedBadges.length === 0) {
    return ok(c, { new_badges: [], message: "All badges already earned or no badges defined" });
  }

  // ══════════════════════════════════════════════════════════════
  // Phase 1: Criteria-based evaluation (in-memory, no extra queries)
  // Uses evalContext built from student_xp + student_stats.
  // 19 badges with criteria field (XP, level, streak thresholds).
  // ══════════════════════════════════════════════════════════════

  const [xpResult, statsResult] = await Promise.all([
    adminDb
      .from("student_xp")
      .select("total_xp, current_level, xp_today, xp_this_week")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .maybeSingle(),
    adminDb
      .from("student_stats")
      .select("current_streak, longest_streak, total_reviews, total_sessions")
      .eq("student_id", user.id)
      .maybeSingle(),
  ]);

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

  const newBadges: Array<Record<string, unknown>> = [];

  for (const badge of unearnedBadges) {
    const criteria = badge.criteria as string;
    if (!criteria) continue;

    const conditions = criteria.split(" AND ").map((s: string) => s.trim());
    const allMet = conditions.every((cond: string) =>
      evaluateSimpleCondition(cond, evalContext),
    );

    if (allMet) {
      const awarded = await tryAwardBadge(adminDb, user.id, institutionId, badge);
      if (awarded) newBadges.push(badge);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Phase 2: COUNT-based evaluation (parallel DB queries)
  // S3-001 + S3-002: Evaluates badges with trigger_config but no criteria.
  // Uses Promise.allSettled for parallel read queries, then sequential
  // writes for badges that passed. ~20x faster than sequential eval.
  //
  // Active tables (ALLOWED_TABLES in helpers.ts):
  //   study_sessions, reading_states, bkt_states, fsrs_states
  //
  // Deactivated (S3-004): ai_conversations, leaderboard_weekly
  //   (tables don't exist; 4 badges set is_active=false)
  // ══════════════════════════════════════════════════════════════

  const awardedIds = new Set(newBadges.map((b) => b.id));

  const countBadges = unearnedBadges.filter(
    (b: Record<string, unknown>) =>
      !b.criteria &&
      b.trigger_config &&
      typeof b.trigger_config === "object" &&
      (b.trigger_config as Record<string, unknown>).table &&
      !awardedIds.has(b.id as string),
  );

  if (countBadges.length > 0) {
    // Parallel evaluation: all COUNT queries fire simultaneously
    const evalResults = await Promise.allSettled(
      countBadges.map(async (badge) => {
        const met = await evaluateCountBadge(
          adminDb,
          user.id,
          badge.trigger_config as TriggerConfig,
        );
        return { badge, met };
      }),
    );

    // Sequential award: only badges that passed evaluation
    for (const result of evalResults) {
      if (result.status === "fulfilled" && result.value.met) {
        const awarded = await tryAwardBadge(adminDb, user.id, institutionId, result.value.badge);
        if (awarded) newBadges.push(result.value.badge);
      } else if (result.status === "rejected") {
        console.error(
          `[Badges] COUNT eval failed:`,
          result.reason,
        );
      }
    }
  }

  return ok(c, {
    new_badges: newBadges,
    checked: unearnedBadges.length,
    awarded: newBadges.length,
  });
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
    // A-001 FIX: icon (correct column, was icon_url)
    // A-003 FIX: Filter badges by institution_id
    db
      .from("student_badges")
      .select("badge_id, created_at, badge_definitions(name, slug, icon, rarity)")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
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
        badge_icon: def?.icon ?? null,
        badge_rarity: def?.rarity ?? null,
        timestamp: badge.created_at,
      });
    }
  }

  // A-002 FIX: Proper sort (removed dead tB variable)
  notifications.sort((a, b) =>
    new Date(b.timestamp as string).getTime() - new Date(a.timestamp as string).getTime()
  );

  return ok(c, {
    notifications: notifications.slice(0, limit),
    total: notifications.length,
  });
});
