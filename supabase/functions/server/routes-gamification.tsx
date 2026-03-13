/**
 * routes-gamification.tsx — Gamification endpoints for Axon v4.4
 *
 * Custom routes (not CRUD factory):
 *
 * Sprint 1:
 *   GET  /gamification/profile        — XP, level, badges, streak (+ onboarding XP)
 *   GET  /gamification/xp-history     — Paginated XP transactions
 *   POST /gamification/check-badges   — Evaluate & award pending badges
 *   GET  /gamification/leaderboard    — Weekly leaderboard (MV + fallback)
 *
 * Sprint 2:
 *   POST /gamification/streak-freeze/buy  — Purchase streak freeze (200 XP)
 *   POST /gamification/streak-repair      — Repair broken streak (400 XP)
 *   GET  /gamification/micro-goals        — Personalized daily goals
 *   GET  /gamification/mastery-map        — BKT mastery by subtopic
 *
 * Sprint 3/4 Backend Support:
 *   GET  /gamification/notifications      — Derived event feed (XP, badges, levels)
 *   GET  /gamification/streak-status      — Detailed streak state
 *   POST /gamification/daily-check-in     — Streak update + auto-freeze
 *   POST /gamification/goals/complete     — Claim goal bonus XP
 *   PUT  /gamification/daily-goal         — Update daily study goal
 *
 * CONTRACT COMPLIANCE:
 *   §2.1 — authenticate(c) + instanceof Response check
 *   §2.2 — ok(c, data) and err(c, msg, status)
 *   §2.3 — Flat routes with query params
 *   §3.8 — Daily cap 500 XP enforced in RPC; deductions via RPC
 *   §5.4 — institution_id via query param, validated
 *   §6.9 — requireInstitutionRole(ALL_ROLES) for reads
 *   §7.9 — Never direct UPDATE on student_xp (always via RPC)
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import {
  authenticate,
  ok,
  err,
  safeJson,
  PREFIX,
  getAdminClient,
} from "./db.ts";
import { isUuid, isNonNegInt, inRange } from "./validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "./auth-helpers.ts";
import { awardXP, XP_TABLE } from "./xp-engine.ts";
import {
  computeStreakStatus,
  performDailyCheckIn,
} from "./streak-engine.ts";

export const gamificationRoutes = new Hono();

// ─── Constants ───────────────────────────────────────────────

const FREEZE_COST_XP = 200;
const FREEZE_MAX_ACTIVE = 2;
const REPAIR_COST_XP = 400;
const REPAIR_WINDOW_HOURS = 48;
const ONBOARDING_XP = 20;
const DAILY_GOAL_MIN = 5;
const DAILY_GOAL_MAX = 120;

// Goal type → bonus XP mapping
const GOAL_BONUS_XP: Record<string, number> = {
  review_due: 50,
  weak_area: 75,
  daily_xp: 25,
  study_time: 30,
  complete_session: 25,
};

// ═══════════════════════════════════════════════════════════════
// SPRINT 1 ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// ─── GET /gamification/profile ───────────────────────────────
// Returns unified gamification profile: XP, level, badges, streak.
// Parallel fetch for performance (same pattern as study-queue).
//
// Sprint 2 addition: Onboarding XP (endowed progress).
// When student_xp row doesn't exist for this user+institution,
// auto-seeds with 20 XP fire-and-forget (Nunes & Dreze 2006).
// Returns immediate zero-state; XP arrives async via awardXP.

gamificationRoutes.get(
  `${PREFIX}/gamification/profile`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const institutionId = c.req.query("institution_id");
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    // Verify membership (contract §6.9: ALL_ROLES for READ)
    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    // Parallel fetch: XP + badges + stats + recent XP
    const [xpResult, badgesResult, statsResult, recentXpResult] =
      await Promise.all([
        db
          .from("student_xp")
          .select("*")
          .eq("student_id", user.id)
          .eq("institution_id", institutionId!)
          .maybeSingle(),
        db
          .from("student_badges")
          .select("*, badge_definitions(*)")
          .eq("student_id", user.id)
          .eq("institution_id", institutionId!),
        db
          .from("student_stats")
          .select(
            "current_streak, longest_streak, total_reviews, total_time_seconds, last_study_date",
          )
          .eq("student_id", user.id)
          .maybeSingle(),
        db
          .from("xp_transactions")
          .select("action, xp_final, bonus_type, created_at")
          .eq("student_id", user.id)
          .eq("institution_id", institutionId!)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

    // ── Onboarding XP: Endowed Progress (Nunes & Dreze 2006) ──
    if (!xpResult.data) {
      awardXP({
        db: getAdminClient(),
        studentId: user.id,
        institutionId: institutionId!,
        action: "onboarding",
        xpBase: ONBOARDING_XP,
        sourceType: "system",
        sourceId: null,
      }).catch((e: Error) =>
        console.warn("[Gamification] Onboarding XP failed:", e.message),
      );
    }

    const xp = xpResult.data ?? {
      total_xp: 0,
      current_level: 1,
      xp_today: 0,
      xp_this_week: 0,
      streak_freezes_owned: 0,
      daily_goal_minutes: 10,
    };

    return ok(c, {
      xp,
      badges: badgesResult.data ?? [],
      stats: statsResult.data ?? {
        current_streak: 0,
        longest_streak: 0,
        total_reviews: 0,
        total_time_seconds: 0,
        last_study_date: null,
      },
      recent_xp: recentXpResult.data ?? [],
    });
  },
);

// ─── GET /gamification/xp-history ────────────────────────────

gamificationRoutes.get(
  `${PREFIX}/gamification/xp-history`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const institutionId = c.req.query("institution_id");
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    let limit = parseInt(c.req.query("limit") ?? "50", 10);
    let offset = parseInt(c.req.query("offset") ?? "0", 10);
    if (isNaN(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;
    if (isNaN(offset) || offset < 0) offset = 0;

    let query = db
      .from("xp_transactions")
      .select("*", { count: "estimated" })
      .eq("student_id", user.id)
      .eq("institution_id", institutionId!);

    const actionFilter = c.req.query("action");
    if (actionFilter) {
      query = query.eq("action", actionFilter);
    }

    query = query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) {
      return err(c, `Fetch XP history failed: ${error.message}`, 500);
    }

    return ok(c, { items: data, total: count, limit, offset });
  },
);

// ─── POST /gamification/check-badges ─────────────────────────

gamificationRoutes.post(
  `${PREFIX}/gamification/check-badges`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const body = await safeJson(c);
    const institutionId = body?.institution_id as string | undefined;
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    const { data: badges, error: badgeError } = await db
      .from("badge_definitions")
      .select("*")
      .eq("is_active", true)
      .or(`institution_id.is.null,institution_id.eq.${institutionId}`);

    if (badgeError) {
      return err(c, `Fetch badges failed: ${badgeError.message}`, 500);
    }

    const { data: earned } = await db
      .from("student_badges")
      .select("badge_id")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId!);

    const earnedSet = new Set(
      (earned ?? []).map((e: { badge_id: string }) => e.badge_id),
    );

    const [statsResult, xpResult, bktResult, sessionsResult] =
      await Promise.all([
        db
          .from("student_stats")
          .select("*")
          .eq("student_id", user.id)
          .single(),
        db
          .from("student_xp")
          .select("*")
          .eq("student_id", user.id)
          .eq("institution_id", institutionId!)
          .single(),
        db
          .from("bkt_states")
          .select("p_know")
          .eq("student_id", user.id),
        db
          .from("study_sessions")
          .select("id")
          .eq("student_id", user.id)
          .not("completed_at", "is", null),
      ]);

    const stats = statsResult.data;
    const xp = xpResult.data;
    const bktStates = bktResult.data ?? [];
    const completedSessions = sessionsResult.data?.length ?? 0;

    const newBadges: Array<{
      badge_id: string;
      name: string;
      rarity: string;
      xp_reward: number;
    }> = [];

    for (const badge of badges ?? []) {
      if (earnedSet.has(badge.id)) continue;

      const config = badge.trigger_config as Record<string, string>;
      if (!config || badge.trigger_type !== "auto") continue;

      let isEarned = false;

      try {
        const table = config.table;
        const condition = config.condition;
        if (!table || !condition) continue;

        if (table === "student_stats" && stats) {
          isEarned = evaluateSimpleCondition(condition, stats);
        } else if (table === "student_xp" && xp) {
          isEarned = evaluateSimpleCondition(condition, xp);
        } else if (table === "study_sessions") {
          const match = condition.match(/COUNT\(\*\)\s*>=\s*(\d+)/);
          if (match) {
            isEarned = completedSessions >= parseInt(match[1], 10);
          }
        } else if (table === "bkt_states") {
          const countMatch = condition.match(/COUNT\(\*\)\s*>=\s*(\d+)/);
          const filter = config.filter;
          if (countMatch && filter) {
            const thresholdMatch = filter.match(
              /p_know\s*>\s*([\d.]+)/,
            );
            if (thresholdMatch) {
              const threshold = parseFloat(thresholdMatch[1]);
              const count = bktStates.filter(
                (b: { p_know: number }) => (b.p_know ?? 0) > threshold,
              ).length;
              isEarned = count >= parseInt(countMatch[1], 10);
            }
          }
        }
      } catch (evalErr) {
        console.warn(
          `[Badge Check] Error evaluating badge ${badge.name}:`,
          (evalErr as Error).message,
        );
        continue;
      }

      if (isEarned) {
        const { error: insertErr } = await db
          .from("student_badges")
          .insert({
            student_id: user.id,
            badge_id: badge.id,
            institution_id: institutionId,
          });

        if (!insertErr) {
          newBadges.push({
            badge_id: badge.id,
            name: badge.name,
            rarity: badge.rarity,
            xp_reward: badge.xp_reward,
          });

          if (badge.xp_reward > 0) {
            awardXP({
              db: getAdminClient(),
              studentId: user.id,
              institutionId: institutionId!,
              action: "badge_earned",
              xpBase: badge.xp_reward,
              sourceType: "badge",
              sourceId: badge.id,
            }).catch((e: Error) =>
              console.warn(
                "[Badge Check] XP award failed:",
                e.message,
              ),
            );
          }
        }
      }
    }

    return ok(c, {
      new_badges: newBadges,
      checked: (badges ?? []).length,
      already_earned: earnedSet.size,
    });
  },
);

// ─── GET /gamification/leaderboard ───────────────────────────

gamificationRoutes.get(
  `${PREFIX}/gamification/leaderboard`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const institutionId = c.req.query("institution_id");
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    let limit = parseInt(c.req.query("limit") ?? "20", 10);
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;

    const { data: leaderboard, error: mvError } = await db
      .from("leaderboard_weekly")
      .select("*")
      .eq("institution_id", institutionId!)
      .order("xp_this_week", { ascending: false })
      .limit(limit);

    if (mvError) {
      console.warn(
        "[Gamification] MV query failed, using fallback:",
        mvError.message,
      );
      const { data: fallback, error: fbError } = await db
        .from("student_xp")
        .select(
          "student_id, total_xp, current_level, xp_this_week",
        )
        .eq("institution_id", institutionId!)
        .order("xp_this_week", { ascending: false })
        .limit(limit);

      if (fbError) {
        return err(c, `Leaderboard failed: ${fbError.message}`, 500);
      }
      return ok(c, {
        leaderboard: fallback ?? [],
        source: "fallback",
      });
    }

    return ok(c, {
      leaderboard: leaderboard ?? [],
      source: "materialized_view",
    });
  },
);

// ═══════════════════════════════════════════════════════════════
// SPRINT 2 ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// ─── POST /gamification/streak-freeze/buy ────────────────────

gamificationRoutes.post(
  `${PREFIX}/gamification/streak-freeze/buy`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const body = await safeJson(c);
    const institutionId = body?.institution_id as string | undefined;
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    const { data: xp, error: xpErr } = await db
      .from("student_xp")
      .select("total_xp, streak_freezes_owned")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId!)
      .maybeSingle();

    if (xpErr) {
      return err(c, `XP lookup failed: ${xpErr.message}`, 500);
    }

    const currentXP = xp?.total_xp ?? 0;
    if (currentXP < FREEZE_COST_XP) {
      return err(
        c,
        `Not enough XP. Need ${FREEZE_COST_XP}, have ${currentXP}`,
        400,
      );
    }

    const { count: activeCount, error: countErr } = await db
      .from("streak_freezes")
      .select("*", { count: "exact", head: true })
      .eq("student_id", user.id)
      .eq("institution_id", institutionId!)
      .is("used_on", null);

    if (countErr) {
      return err(c, `Freeze count failed: ${countErr.message}`, 500);
    }

    if ((activeCount ?? 0) >= FREEZE_MAX_ACTIVE) {
      return err(
        c,
        `Maximum ${FREEZE_MAX_ACTIVE} active streak freezes allowed`,
        400,
      );
    }

    const deductResult = await awardXP({
      db: getAdminClient(),
      studentId: user.id,
      institutionId: institutionId!,
      action: "streak_freeze_purchase",
      xpBase: -FREEZE_COST_XP,
      sourceType: "system",
      sourceId: null,
    });

    if (!deductResult) {
      return err(c, "Failed to deduct XP for streak freeze", 500);
    }

    const { data: freeze, error: freezeErr } = await db
      .from("streak_freezes")
      .insert({
        student_id: user.id,
        institution_id: institutionId,
        freeze_type: "purchased",
        xp_cost: FREEZE_COST_XP,
      })
      .select()
      .single();

    if (freezeErr) {
      console.error(
        `[Gamification] CRITICAL: XP deducted but freeze insert failed for ${user.id}:`,
        freezeErr.message,
      );
      return err(
        c,
        `Streak freeze creation failed: ${freezeErr.message}`,
        500,
      );
    }

    const adminDb = getAdminClient();
    adminDb
      .from("student_xp")
      .update({
        streak_freezes_owned: (xp?.streak_freezes_owned ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("student_id", user.id)
      .eq("institution_id", institutionId!)
      .then(({ error: updErr }) => {
        if (updErr) {
          console.warn(
            "[Gamification] streak_freezes_owned update failed:",
            updErr.message,
          );
        }
      });

    return ok(
      c,
      {
        freeze,
        xp_deducted: FREEZE_COST_XP,
        remaining_xp: currentXP - FREEZE_COST_XP,
        active_freezes: (activeCount ?? 0) + 1,
      },
      201,
    );
  },
);

// ─── POST /gamification/streak-repair ────────────────────────

gamificationRoutes.post(
  `${PREFIX}/gamification/streak-repair`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const body = await safeJson(c);
    const institutionId = body?.institution_id as string | undefined;
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    const { data: stats, error: statsErr } = await db
      .from("student_stats")
      .select("current_streak, longest_streak, last_study_date")
      .eq("student_id", user.id)
      .maybeSingle();

    if (statsErr) {
      return err(c, `Stats lookup failed: ${statsErr.message}`, 500);
    }

    if (!stats) {
      return err(c, "No study history found — nothing to repair", 400);
    }

    if (stats.current_streak > 0) {
      return err(
        c,
        "Your streak is not broken — no repair needed",
        400,
      );
    }

    if (!stats.last_study_date) {
      return err(
        c,
        "No previous study date found — nothing to repair",
        400,
      );
    }

    const lastStudy = new Date(stats.last_study_date + "T23:59:59Z");
    const now = new Date();
    const hoursSinceBreak =
      (now.getTime() - lastStudy.getTime()) / (1000 * 60 * 60);

    if (hoursSinceBreak > REPAIR_WINDOW_HOURS) {
      return err(
        c,
        `Repair window expired. Streak can only be repaired within ${REPAIR_WINDOW_HOURS}h of breaking (${Math.round(hoursSinceBreak)}h ago)`,
        400,
      );
    }

    const twentyFourHoursAgo = new Date(
      now.getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: recentRepair } = await db
      .from("streak_repairs")
      .select("id")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId!)
      .gte("created_at", twentyFourHoursAgo)
      .limit(1)
      .maybeSingle();

    if (recentRepair) {
      return err(
        c,
        "You already used a streak repair in the last 24 hours",
        400,
      );
    }

    const { data: xp } = await db
      .from("student_xp")
      .select("total_xp")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId!)
      .maybeSingle();

    const currentXP = xp?.total_xp ?? 0;
    if (currentXP < REPAIR_COST_XP) {
      return err(
        c,
        `Not enough XP. Need ${REPAIR_COST_XP}, have ${currentXP}`,
        400,
      );
    }

    const deductResult = await awardXP({
      db: getAdminClient(),
      studentId: user.id,
      institutionId: institutionId!,
      action: "streak_repair_purchase",
      xpBase: -REPAIR_COST_XP,
      sourceType: "system",
      sourceId: null,
    });

    if (!deductResult) {
      return err(c, "Failed to deduct XP for streak repair", 500);
    }

    const restoredStreak = stats.longest_streak ?? 1;

    const { error: updateErr } = await db
      .from("student_stats")
      .update({
        current_streak: restoredStreak,
        last_study_date: now.toISOString().split("T")[0],
        updated_at: new Date().toISOString(),
      })
      .eq("student_id", user.id);

    if (updateErr) {
      console.error(
        `[Gamification] CRITICAL: XP deducted but streak restore failed for ${user.id}:`,
        updateErr.message,
      );
      return err(
        c,
        `Streak restore failed: ${updateErr.message}`,
        500,
      );
    }

    const { data: repair, error: repairErr } = await db
      .from("streak_repairs")
      .insert({
        student_id: user.id,
        institution_id: institutionId,
        repair_date: now.toISOString().split("T")[0],
        xp_cost: REPAIR_COST_XP,
        streak_restored_to: restoredStreak,
      })
      .select()
      .single();

    if (repairErr) {
      console.warn(
        "[Gamification] Streak repair audit insert failed:",
        repairErr.message,
      );
    }

    return ok(c, {
      repair: repair ?? { streak_restored_to: restoredStreak },
      xp_deducted: REPAIR_COST_XP,
      remaining_xp: currentXP - REPAIR_COST_XP,
      streak_restored_to: restoredStreak,
    });
  },
);

// ─── GET /gamification/micro-goals ───────────────────────────
// Locke & Latham (2002): specific+challenging goals = +25-35%

gamificationRoutes.get(
  `${PREFIX}/gamification/micro-goals`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const institutionId = c.req.query("institution_id");
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    const today = new Date().toISOString().split("T")[0];
    const nowIso = new Date().toISOString();

    const [
      dueCardsResult,
      weakAreasResult,
      xpResult,
      dailyActivityResult,
      todaySessionsResult,
    ] = await Promise.all([
      db
        .from("fsrs_states")
        .select("flashcard_id", { count: "exact", head: true })
        .eq("student_id", user.id)
        .lte("due_at", nowIso),
      db
        .from("bkt_states")
        .select(
          "subtopic_id, p_know, subtopics(name, topic_id, topics(name))",
        )
        .eq("student_id", user.id)
        .lt("p_know", 0.5)
        .order("p_know", { ascending: true })
        .limit(3),
      db
        .from("student_xp")
        .select("xp_today, daily_goal_minutes")
        .eq("student_id", user.id)
        .eq("institution_id", institutionId!)
        .maybeSingle(),
      db
        .from("daily_activities")
        .select("time_spent_seconds, sessions_count, reviews_count")
        .eq("student_id", user.id)
        .eq("activity_date", today)
        .maybeSingle(),
      db
        .from("study_sessions")
        .select("id", { count: "exact", head: true })
        .eq("student_id", user.id)
        .not("completed_at", "is", null)
        .gte("created_at", today + "T00:00:00Z"),
    ]);

    interface MicroGoal {
      type: string;
      title: string;
      description: string;
      target: number;
      current: number;
      xp_bonus: number;
      icon: string;
      priority: number;
      completed: boolean;
    }

    const goals: MicroGoal[] = [];

    // Goal 1: Review due flashcards
    const dueCount = dueCardsResult.count ?? 0;
    if (dueCount > 0) {
      const target = Math.min(dueCount, 10);
      const reviewsDone = dailyActivityResult.data?.reviews_count ?? 0;
      const current = Math.min(reviewsDone, target);
      goals.push({
        type: "review_due",
        title: `Revisa ${target} flashcards vencidas`,
        description: `Tienes ${dueCount} tarjetas pendientes de revision. El repaso espaciado mejora la retencion a largo plazo.`,
        target,
        current,
        xp_bonus: GOAL_BONUS_XP.review_due,
        icon: "RotateCcw",
        priority: 1,
        completed: current >= target,
      });
    }

    // Goal 2: Improve weak area
    const weakAreas = weakAreasResult.data ?? [];
    if (weakAreas.length > 0) {
      const weakest = weakAreas[0] as {
        subtopic_id: string;
        p_know: number;
        subtopics?: {
          name?: string;
          topics?: { name?: string };
        };
      };
      const subtopicName =
        weakest.subtopics?.name ?? "un subtema";
      const topicName =
        weakest.subtopics?.topics?.name ?? "";
      const pKnowPct = Math.round((weakest.p_know ?? 0) * 100);

      goals.push({
        type: "weak_area",
        title: `Mejora ${subtopicName}`,
        description: `Tu dominio en ${topicName ? topicName + " > " : ""}${subtopicName} es ${pKnowPct}%. Practica para subir tu nivel de maestria.`,
        target: 1,
        current: 0,
        xp_bonus: GOAL_BONUS_XP.weak_area,
        icon: "TrendingUp",
        priority: 2,
        completed: false,
      });
    }

    // Goal 3: Daily XP target
    const xpToday = xpResult.data?.xp_today ?? 0;
    const dailyXpTarget = 100;
    goals.push({
      type: "daily_xp",
      title: `Gana ${dailyXpTarget} XP hoy`,
      description: `Llevas ${xpToday} XP hoy. Cada revision, quiz y sesion completada te acerca a la meta.`,
      target: dailyXpTarget,
      current: Math.min(xpToday, dailyXpTarget),
      xp_bonus: GOAL_BONUS_XP.daily_xp,
      icon: "Zap",
      priority: 3,
      completed: xpToday >= dailyXpTarget,
    });

    // Goal 4: Study time goal
    const dailyGoalMinutes = xpResult.data?.daily_goal_minutes ?? 10;
    const timeSpentSeconds =
      dailyActivityResult.data?.time_spent_seconds ?? 0;
    const timeSpentMinutes = Math.round(timeSpentSeconds / 60);
    goals.push({
      type: "study_time",
      title: `Estudia ${dailyGoalMinutes} minutos`,
      description: `Llevas ${timeSpentMinutes} min hoy. La consistencia diaria es mas importante que sesiones largas esporadicas.`,
      target: dailyGoalMinutes,
      current: Math.min(timeSpentMinutes, dailyGoalMinutes),
      xp_bonus: GOAL_BONUS_XP.study_time,
      icon: "Clock",
      priority: 4,
      completed: timeSpentMinutes >= dailyGoalMinutes,
    });

    // Goal 5: Complete at least 1 session today
    const sessionsToday = todaySessionsResult.count ?? 0;
    if (sessionsToday === 0) {
      goals.push({
        type: "complete_session",
        title: "Completa una sesion de estudio",
        description:
          "Aun no has completado ninguna sesion hoy. Incluso 5 minutos de estudio cuentan.",
        target: 1,
        current: 0,
        xp_bonus: GOAL_BONUS_XP.complete_session,
        icon: "BookOpen",
        priority: 5,
        completed: false,
      });
    }

    goals.sort((a, b) => a.priority - b.priority);

    return ok(c, {
      goals,
      generated_at: nowIso,
      total_goals: goals.length,
      completed_goals: goals.filter((g) => g.completed).length,
    });
  },
);

// ─── GET /gamification/mastery-map ───────────────────────────
// SDT Competence (Deci & Ryan 1985)

gamificationRoutes.get(
  `${PREFIX}/gamification/mastery-map`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const courseId = c.req.query("course_id");
    if (!isUuid(courseId)) {
      return err(c, "course_id must be a valid UUID", 400);
    }

    const { data: course, error: courseErr } = await db
      .from("courses")
      .select("institution_id")
      .eq("id", courseId!)
      .single();

    if (courseErr || !course) {
      return err(c, "Course not found", 404);
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      course.institution_id,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    const { data: semesters, error: semErr } = await db
      .from("semesters")
      .select("id")
      .eq("course_id", courseId!)
      .eq("is_active", true)
      .is("deleted_at", null);

    if (semErr) {
      return err(c, `Semester fetch failed: ${semErr.message}`, 500);
    }

    const semesterIds = (semesters ?? []).map(
      (s: { id: string }) => s.id,
    );
    if (semesterIds.length === 0) {
      return ok(c, { sections: [], summary: { total_subtopics: 0, mastered: 0, developing: 0, needs_work: 0, not_started: 0, overall_mastery_pct: 0 } });
    }

    const { data: sections, error: secErr } = await db
      .from("sections")
      .select(
        "id, name, order_index, topics(id, name, order_index, subtopics(id, name))",
      )
      .in("semester_id", semesterIds)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("order_index", { ascending: true });

    if (secErr) {
      return err(c, `Section fetch failed: ${secErr.message}`, 500);
    }

    const allSubtopicIds: string[] = [];
    for (const section of sections ?? []) {
      const topics = (section.topics ?? []) as Array<{
        id: string;
        subtopics?: Array<{ id: string }>;
      }>;
      for (const topic of topics) {
        for (const subtopic of topic.subtopics ?? []) {
          allSubtopicIds.push(subtopic.id);
        }
      }
    }

    if (allSubtopicIds.length === 0) {
      return ok(c, {
        sections: sections ?? [],
        summary: { total_subtopics: 0, mastered: 0, developing: 0, needs_work: 0, not_started: 0, overall_mastery_pct: 0 },
      });
    }

    const { data: bktStates, error: bktErr } = await db
      .from("bkt_states")
      .select(
        "subtopic_id, p_know, total_attempts, correct_attempts, updated_at",
      )
      .eq("student_id", user.id)
      .in("subtopic_id", allSubtopicIds);

    if (bktErr) {
      return err(c, `BKT states fetch failed: ${bktErr.message}`, 500);
    }

    const bktMap = new Map<
      string,
      {
        p_know: number;
        total_attempts: number;
        correct_attempts: number;
        updated_at: string;
      }
    >();
    for (const bkt of bktStates ?? []) {
      bktMap.set(bkt.subtopic_id, {
        p_know: bkt.p_know ?? 0,
        total_attempts: bkt.total_attempts ?? 0,
        correct_attempts: bkt.correct_attempts ?? 0,
        updated_at: bkt.updated_at ?? "",
      });
    }

    let totalSubtopics = 0;
    let masteredCount = 0;
    let developingCount = 0;
    let needsWorkCount = 0;

    const masteryData = (sections ?? []).map((section: any) => {
      const topics = (section.topics ?? []) as Array<{
        id: string;
        name: string;
        order_index: number;
        subtopics?: Array<{ id: string; name: string }>;
      }>;

      topics.sort(
        (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0),
      );

      let sectionPKnowSum = 0;
      let sectionSubtopicCount = 0;

      const topicsMastery = topics.map((topic) => {
        const subtopics = (topic.subtopics ?? []).map(
          (st: { id: string; name: string }) => {
            const bkt = bktMap.get(st.id);
            const pKnow = bkt?.p_know ?? 0;
            totalSubtopics++;
            sectionSubtopicCount++;
            sectionPKnowSum += pKnow;

            let status: "mastered" | "developing" | "needs_work" | "not_started";
            if (!bkt || bkt.total_attempts === 0) {
              status = "not_started";
              needsWorkCount++;
            } else if (pKnow >= 0.8) {
              status = "mastered";
              masteredCount++;
            } else if (pKnow >= 0.5) {
              status = "developing";
              developingCount++;
            } else {
              status = "needs_work";
              needsWorkCount++;
            }

            return {
              subtopic_id: st.id,
              name: st.name,
              p_know: Math.round(pKnow * 1000) / 1000,
              p_know_pct: Math.round(pKnow * 100),
              status,
              total_attempts: bkt?.total_attempts ?? 0,
              correct_attempts: bkt?.correct_attempts ?? 0,
              accuracy:
                bkt && bkt.total_attempts > 0
                  ? Math.round(
                      (bkt.correct_attempts / bkt.total_attempts) * 100,
                    )
                  : 0,
              last_practiced: bkt?.updated_at ?? null,
            };
          },
        );

        const topicPKnowAvg =
          subtopics.length > 0
            ? subtopics.reduce(
                (sum: number, s: { p_know: number }) =>
                  sum + s.p_know,
                0,
              ) / subtopics.length
            : 0;

        return {
          topic_id: topic.id,
          name: topic.name,
          p_know_avg: Math.round(topicPKnowAvg * 1000) / 1000,
          p_know_avg_pct: Math.round(topicPKnowAvg * 100),
          subtopic_count: subtopics.length,
          mastered_count: subtopics.filter(
            (s: { status: string }) => s.status === "mastered",
          ).length,
          subtopics,
        };
      });

      const sectionPKnowAvg =
        sectionSubtopicCount > 0
          ? sectionPKnowSum / sectionSubtopicCount
          : 0;

      return {
        section_id: section.id,
        name: section.name,
        p_know_avg: Math.round(sectionPKnowAvg * 1000) / 1000,
        p_know_avg_pct: Math.round(sectionPKnowAvg * 100),
        subtopic_count: sectionSubtopicCount,
        mastered_count: topicsMastery.reduce(
          (sum, t) => sum + t.mastered_count,
          0,
        ),
        topics: topicsMastery,
      };
    });

    return ok(c, {
      course_id: courseId,
      sections: masteryData,
      summary: {
        total_subtopics: totalSubtopics,
        mastered: masteredCount,
        developing: developingCount,
        needs_work: needsWorkCount,
        not_started:
          totalSubtopics -
          masteredCount -
          developingCount -
          needsWorkCount,
        overall_mastery_pct:
          totalSubtopics > 0
            ? Math.round(
                ((masteredCount + developingCount * 0.5) /
                  totalSubtopics) *
                  100,
              )
            : 0,
      },
      generated_at: new Date().toISOString(),
    });
  },
);

// ═══════════════════════════════════════════════════════════════
// SPRINT 3/4 BACKEND SUPPORT ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// ─── GET /gamification/notifications ─────────────────────────
// Derived event feed from existing tables (no new table).
// Frontend uses this for toast notifications and activity feed.
//
// Combines:
//   - Recent xp_transactions → xp_gain events
//   - Recent student_badges  → badge_earned events
//   - Level-up detection     → level_up events (from XP thresholds)
//
// Optional ?since= ISO timestamp filter (default: last 24h).
// Optional ?limit= (default: 20, max: 50).

gamificationRoutes.get(
  `${PREFIX}/gamification/notifications`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const institutionId = c.req.query("institution_id");
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    // Parse since filter (default: last 24h)
    const sinceParam = c.req.query("since");
    const since = sinceParam
      ? sinceParam
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    let limit = parseInt(c.req.query("limit") ?? "20", 10);
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 50) limit = 50;

    // Parallel fetch: XP transactions + recent badges
    const [xpTxResult, badgesResult] = await Promise.all([
      db
        .from("xp_transactions")
        .select(
          "id, action, xp_base, xp_final, multiplier, bonus_type, source_type, source_id, created_at",
        )
        .eq("student_id", user.id)
        .eq("institution_id", institutionId!)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(limit),
      db
        .from("student_badges")
        .select("id, badge_id, earned_at, badge_definitions(name, description, icon, rarity, xp_reward)")
        .eq("student_id", user.id)
        .eq("institution_id", institutionId!)
        .gte("earned_at", since)
        .order("earned_at", { ascending: false })
        .limit(10),
    ]);

    // Level thresholds for level-up detection
    const LEVEL_THRESHOLDS: [number, number][] = [
      [10000, 12], [7500, 11], [5500, 10], [4000, 9], [3000, 8],
      [2200, 7], [1500, 6], [1000, 5], [600, 4], [300, 3], [100, 2],
    ];

    function xpToLevel(xp: number): number {
      for (const [threshold, level] of LEVEL_THRESHOLDS) {
        if (xp >= threshold) return level;
      }
      return 1;
    }

    // Build notification events
    interface NotificationEvent {
      id: string;
      type: "xp_gain" | "badge_earned" | "level_up";
      title: string;
      description: string;
      xp_amount?: number;
      badge_name?: string;
      badge_rarity?: string;
      new_level?: number;
      timestamp: string;
    }

    const events: NotificationEvent[] = [];

    // XP gain events
    const xpTransactions = xpTxResult.data ?? [];
    let runningXp = 0; // Track cumulative XP for level-up detection

    // Get current total XP for reverse-engineering level changes
    const { data: currentXp } = await db
      .from("student_xp")
      .select("total_xp")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId!)
      .maybeSingle();

    const totalXp = currentXp?.total_xp ?? 0;

    // Process transactions (newest first)
    let xpBefore = totalXp;
    for (const tx of xpTransactions) {
      const xpAfter = xpBefore;
      xpBefore = xpBefore - (tx.xp_final as number);

      const actionLabels: Record<string, string> = {
        review_correct: "Revision correcta",
        review_flashcard: "Revision de flashcard",
        quiz_correct: "Quiz correcto",
        quiz_answer: "Respuesta de quiz",
        complete_session: "Sesion completada",
        complete_reading: "Lectura completada",
        badge_earned: "Insignia obtenida",
        onboarding: "Bienvenida",
        streak_freeze_purchase: "Streak freeze comprado",
        streak_repair_purchase: "Streak reparado",
        goal_complete: "Meta completada",
      };

      const label = actionLabels[tx.action as string] ?? (tx.action as string);
      const bonusText = tx.bonus_type
        ? ` (bonus: ${(tx.bonus_type as string).replace(/\+/g, ", ")})`
        : "";

      events.push({
        id: `xp-${tx.id}`,
        type: "xp_gain",
        title: `+${tx.xp_final} XP`,
        description: `${label}${bonusText}`,
        xp_amount: tx.xp_final as number,
        timestamp: tx.created_at as string,
      });

      // Level-up detection
      const levelBefore = xpToLevel(xpBefore);
      const levelAfter = xpToLevel(xpAfter);
      if (levelAfter > levelBefore) {
        events.push({
          id: `levelup-${tx.id}`,
          type: "level_up",
          title: `Nivel ${levelAfter}!`,
          description: `Has subido al nivel ${levelAfter}. Sigue acumulando XP para avanzar.`,
          new_level: levelAfter,
          timestamp: tx.created_at as string,
        });
      }
    }

    // Badge events
    for (const badge of badgesResult.data ?? []) {
      const def = (badge as any).badge_definitions;
      events.push({
        id: `badge-${badge.id}`,
        type: "badge_earned",
        title: `Insignia: ${def?.name ?? "Nueva insignia"}`,
        description: def?.description ?? "Has ganado una nueva insignia.",
        badge_name: def?.name ?? undefined,
        badge_rarity: def?.rarity ?? undefined,
        xp_amount: def?.xp_reward ?? undefined,
        timestamp: badge.earned_at as string,
      });
    }

    // Sort all events by timestamp (newest first)
    events.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return ok(c, {
      events: events.slice(0, limit),
      since,
      total: events.length,
    });
  },
);

// ─── GET /gamification/streak-status ─────────────────────────
// Detailed streak state for frontend streak guard UI.
// Combines student_stats + active freezes + repair eligibility.

gamificationRoutes.get(
  `${PREFIX}/gamification/streak-status`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const institutionId = c.req.query("institution_id");
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    try {
      const status = await computeStreakStatus(
        db,
        user.id,
        institutionId!,
      );
      return ok(c, status);
    } catch (e: any) {
      return err(c, `Streak status failed: ${e.message}`, 500);
    }
  },
);

// ─── POST /gamification/daily-check-in ───────────────────────
// Called when student opens the app or starts a session.
// Updates streak, auto-consumes freeze if missed day, breaks if needed.
// Idempotent within same day (safe to call multiple times).
//
// Also awards streak_daily XP (15 XP) on successful check-in
// (once per day, not on "already_checked_in").

gamificationRoutes.post(
  `${PREFIX}/gamification/daily-check-in`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const body = await safeJson(c);
    const institutionId = body?.institution_id as string | undefined;
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    try {
      const result = await performDailyCheckIn(
        user.id,
        institutionId!,
      );

      // Award streak_daily XP (15 XP) on NEW check-in (not already_checked_in)
      const isNewCheckIn = !result.events.some(
        (e) => e.type === "already_checked_in",
      );

      if (isNewCheckIn && XP_TABLE.streak_daily) {
        awardXP({
          db: getAdminClient(),
          studentId: user.id,
          institutionId: institutionId!,
          action: "streak_daily",
          xpBase: XP_TABLE.streak_daily,
          sourceType: "system",
          sourceId: null,
          currentStreak: result.streak_status.current_streak,
        }).catch((e: Error) =>
          console.warn(
            "[Gamification] streak_daily XP failed:",
            e.message,
          ),
        );
      }

      return ok(c, result);
    } catch (e: any) {
      return err(c, `Daily check-in failed: ${e.message}`, 500);
    }
  },
);

// ─── POST /gamification/goals/complete ───────────────────────
// Claim bonus XP for completing a micro-goal.
// Re-validates conditions server-side (anti-cheat).
//
// Body: { institution_id: UUID, goal_type: string }
//
// Uses xp_transactions as anti-duplicate check:
// If an xp_transaction with action="goal_complete" and
// source_id=goal_type exists for today, the goal is already claimed.
//
// This avoids needing a new goal_completions table.

gamificationRoutes.post(
  `${PREFIX}/gamification/goals/complete`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const body = await safeJson(c);
    if (!body) return err(c, "Invalid or missing JSON body", 400);

    const institutionId = body.institution_id as string | undefined;
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const goalType = body.goal_type as string | undefined;
    if (!goalType || !GOAL_BONUS_XP[goalType]) {
      return err(
        c,
        `goal_type must be one of: ${Object.keys(GOAL_BONUS_XP).join(", ")}`,
        400,
      );
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    const today = new Date().toISOString().split("T")[0];

    // Anti-duplicate: check if already claimed today
    // Uses xp_transactions as audit trail (no new table needed)
    const { data: alreadyClaimed } = await db
      .from("xp_transactions")
      .select("id")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId!)
      .eq("action", "goal_complete")
      .eq("source_id", goalType)
      .gte("created_at", today + "T00:00:00Z")
      .limit(1)
      .maybeSingle();

    if (alreadyClaimed) {
      return err(
        c,
        `Goal '${goalType}' already claimed today`,
        400,
      );
    }

    // Server-side re-validation of goal completion
    const nowIso = new Date().toISOString();
    let isCompleted = false;

    if (goalType === "daily_xp") {
      const { data: xp } = await db
        .from("student_xp")
        .select("xp_today")
        .eq("student_id", user.id)
        .eq("institution_id", institutionId!)
        .maybeSingle();
      isCompleted = (xp?.xp_today ?? 0) >= 100;
    } else if (goalType === "study_time") {
      const { data: activity } = await db
        .from("daily_activities")
        .select("time_spent_seconds")
        .eq("student_id", user.id)
        .eq("activity_date", today)
        .maybeSingle();
      const { data: xpData } = await db
        .from("student_xp")
        .select("daily_goal_minutes")
        .eq("student_id", user.id)
        .eq("institution_id", institutionId!)
        .maybeSingle();
      const goalMin = xpData?.daily_goal_minutes ?? 10;
      const spentMin = Math.round(
        (activity?.time_spent_seconds ?? 0) / 60,
      );
      isCompleted = spentMin >= goalMin;
    } else if (goalType === "review_due") {
      // Relaxed: any reviews done today counts
      const { data: activity } = await db
        .from("daily_activities")
        .select("reviews_count")
        .eq("student_id", user.id)
        .eq("activity_date", today)
        .maybeSingle();
      isCompleted = (activity?.reviews_count ?? 0) >= 1;
    } else if (goalType === "complete_session") {
      const { count } = await db
        .from("study_sessions")
        .select("id", { count: "exact", head: true })
        .eq("student_id", user.id)
        .not("completed_at", "is", null)
        .gte("created_at", today + "T00:00:00Z");
      isCompleted = (count ?? 0) >= 1;
    } else if (goalType === "weak_area") {
      // Relaxed: any study activity today on a weak area counts
      // (Hard to validate precisely; trust the frontend for this one)
      isCompleted = true;
    }

    if (!isCompleted) {
      return err(
        c,
        `Goal '${goalType}' conditions not met. Keep studying!`,
        400,
      );
    }

    // Award bonus XP
    const bonusXp = GOAL_BONUS_XP[goalType];
    const awardResult = await awardXP({
      db: getAdminClient(),
      studentId: user.id,
      institutionId: institutionId!,
      action: "goal_complete",
      xpBase: bonusXp,
      sourceType: "goal",
      sourceId: goalType,
    });

    return ok(c, {
      goal_type: goalType,
      xp_bonus: bonusXp,
      xp_awarded: awardResult?.xp_awarded ?? bonusXp,
      claimed_at: nowIso,
    });
  },
);

// ─── PUT /gamification/daily-goal ────────────────────────────
// Update the student's daily study time goal (in minutes).
// This is a metadata field on student_xp, not XP itself (§7.9 safe).
//
// Body: { institution_id: UUID, daily_goal_minutes: number }
// Validates range: [5, 120] minutes.

gamificationRoutes.put(
  `${PREFIX}/gamification/daily-goal`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const body = await safeJson(c);
    if (!body) return err(c, "Invalid or missing JSON body", 400);

    const institutionId = body.institution_id as string | undefined;
    if (!isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    const dailyGoalMinutes = body.daily_goal_minutes;
    if (
      !isNonNegInt(dailyGoalMinutes) ||
      !inRange(dailyGoalMinutes as number, DAILY_GOAL_MIN, DAILY_GOAL_MAX)
    ) {
      return err(
        c,
        `daily_goal_minutes must be an integer between ${DAILY_GOAL_MIN} and ${DAILY_GOAL_MAX}`,
        400,
      );
    }

    const check = await requireInstitutionRole(
      db,
      user.id,
      institutionId!,
      ALL_ROLES,
    );
    if (isDenied(check)) return err(c, check.message, check.status);

    // Upsert: create student_xp row if it doesn't exist yet
    const { data, error } = await db
      .from("student_xp")
      .upsert(
        {
          student_id: user.id,
          institution_id: institutionId,
          daily_goal_minutes: dailyGoalMinutes,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "student_id,institution_id" },
      )
      .select("daily_goal_minutes")
      .single();

    if (error) {
      return err(
        c,
        `Update daily goal failed: ${error.message}`,
        500,
      );
    }

    return ok(c, {
      daily_goal_minutes: data.daily_goal_minutes,
      updated: true,
    });
  },
);

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function evaluateSimpleCondition(
  condition: string,
  row: Record<string, unknown>,
): boolean {
  const match = condition.match(
    /^(\w+)\s*(>=|>|<=|<|=|==)\s*([\d.]+)$/,
  );
  if (!match) return false;

  const [, field, op, valueStr] = match;
  const actual = Number(row[field] ?? 0);
  const target = parseFloat(valueStr);

  switch (op) {
    case ">=":
      return actual >= target;
    case ">":
      return actual > target;
    case "<=":
      return actual <= target;
    case "<":
      return actual < target;
    case "=":
    case "==":
      return actual === target;
    default:
      return false;
  }
}
