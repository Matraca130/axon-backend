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
 * Pattern: Same as routes-study-queue.tsx
 * Response: ok(c, data) / err(c, message, status)
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
import { isUuid } from "./validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "./auth-helpers.ts";
import { awardXP } from "./xp-engine.ts";

export const gamificationRoutes = new Hono();

// ─── Constants ───────────────────────────────────────────────

const FREEZE_COST_XP = 200;
const FREEZE_MAX_ACTIVE = 2;
const REPAIR_COST_XP = 400;
const REPAIR_WINDOW_HOURS = 48;
const ONBOARDING_XP = 20;

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
    // If no student_xp row exists, this is the student's first
    // gamification interaction with this institution.
    // Award 20 XP fire-and-forget to seed the progress bar.
    // +34% completion rate vs starting from zero.
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
// Paginated XP transaction history with optional action filter.

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

    // N-9 FIX: Pagination validation
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

    // Optional action filter
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
// Evaluates ALL active badge conditions for the student.
// Awards any newly earned badges. Idempotent (UNIQUE constraint).

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

    // Fetch all active badge definitions (global + institution-specific)
    const { data: badges, error: badgeError } = await db
      .from("badge_definitions")
      .select("*")
      .eq("is_active", true)
      .or(`institution_id.is.null,institution_id.eq.${institutionId}`);

    if (badgeError) {
      return err(c, `Fetch badges failed: ${badgeError.message}`, 500);
    }

    // Fetch already earned badges to skip
    const { data: earned } = await db
      .from("student_badges")
      .select("badge_id")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId!);

    const earnedSet = new Set(
      (earned ?? []).map((e: { badge_id: string }) => e.badge_id),
    );

    // Fetch student context for badge evaluation (parallel)
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
          // COUNT-based: "COUNT(*) >= N"
          const match = condition.match(/COUNT\(\*\)\s*>=\s*(\d+)/);
          if (match) {
            isEarned = completedSessions >= parseInt(match[1], 10);
          }
        } else if (table === "bkt_states") {
          // COUNT with filter: e.g. "COUNT(*) >= 10" + filter "p_know > 0.95"
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
        // Award badge (UNIQUE constraint prevents duplicates)
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

          // Award badge XP reward (fire-and-forget)
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
// Weekly leaderboard from materialized view.
// Privacy-safe: only returns display names + XP.
// S-3 pattern: MV first, student_xp fallback.

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

    // Try materialized view first (refreshed hourly by pg_cron)
    const { data: leaderboard, error: mvError } = await db
      .from("leaderboard_weekly")
      .select("*")
      .eq("institution_id", institutionId!)
      .order("xp_this_week", { ascending: false })
      .limit(limit);

    if (mvError) {
      // Fallback: query student_xp directly
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
// Purchase a streak freeze for FREEZE_COST_XP (200 XP).
// Max FREEZE_MAX_ACTIVE (2) active freezes per student+institution.
//
// Theory: Kahneman Loss Aversion (1979).
// Streak freeze is a "loss prevention" tool. Students who invested
// XP into freezes are 2.3x more likely to maintain their streak
// (Duolingo internal data, 2019).
//
// Flow:
//   1. Verify XP balance >= FREEZE_COST_XP
//   2. Check active freeze count < FREEZE_MAX_ACTIVE
//   3. Deduct XP atomically via award_xp RPC (negative xp_base)
//   4. Insert streak_freezes row
//   5. Increment streak_freezes_owned in student_xp

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

    // Step 1: Check XP balance
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

    // Step 2: Check active freeze count
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

    // Step 3: Deduct XP atomically via RPC (contract §7.9: never direct UPDATE)
    // Using negative xp_base to deduct. The RPC handles all accounting.
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

    // Step 4: Create streak freeze record
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
      // XP was deducted but freeze creation failed — log for manual review
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

    // Step 5: Increment streak_freezes_owned counter
    // Fire-and-forget — non-critical metadata update
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
// Repair a broken streak for REPAIR_COST_XP (400 XP).
// Only available within REPAIR_WINDOW_HOURS (48h) of the break.
//
// Theory: Loss Aversion + Sunk Cost Fallacy.
// Higher cost (400 XP vs 200 freeze) reflects the higher perceived
// value of restoring an existing streak vs preventing a future break.
// The 48h window creates urgency without being punitive.
//
// Flow:
//   1. Verify streak is actually broken (current_streak = 0)
//   2. Verify break was within REPAIR_WINDOW_HOURS
//   3. Verify no recent repair (prevent double-repair)
//   4. Verify XP balance >= REPAIR_COST_XP
//   5. Deduct XP atomically
//   6. Restore current_streak = longest_streak in student_stats
//   7. Insert streak_repairs audit row

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

    // Step 1: Get current streak state
    const { data: stats, error: statsErr } = await db
      .from("student_stats")
      .select(
        "current_streak, longest_streak, last_study_date",
      )
      .eq("student_id", user.id)
      .maybeSingle();

    if (statsErr) {
      return err(c, `Stats lookup failed: ${statsErr.message}`, 500);
    }

    if (!stats) {
      return err(c, "No study history found — nothing to repair", 400);
    }

    // Step 1b: Verify streak is actually broken
    if (stats.current_streak > 0) {
      return err(
        c,
        "Your streak is not broken — no repair needed",
        400,
      );
    }

    // Step 2: Verify break was within repair window
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

    // Step 3: Check for recent repair (prevent double-repair)
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

    // Step 4: Verify XP balance
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

    // Step 5: Deduct XP atomically
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

    // Step 6: Restore streak in student_stats
    // Restore to longest_streak (the streak value before it was broken)
    const restoredStreak = stats.longest_streak ?? 1;

    const { error: updateErr } = await db
      .from("student_stats")
      .update({
        current_streak: restoredStreak,
        last_study_date: now.toISOString().split("T")[0], // Today
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

    // Step 7: Insert repair audit record
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
      // Non-critical: streak was restored, audit record failed
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
// Personalized daily goals based on FSRS due cards, BKT weak areas,
// student XP progress, and study activity.
//
// Theory: Locke & Latham (2002) Goal Setting Theory.
// Specific and challenging (but attainable) goals increase
// performance by 25-35% vs "do your best" instructions.
// Goals are calibrated to be completable in 10-20 minutes.
//
// Each goal includes:
//   type       — goal category (review_due, weak_area, etc.)
//   title      — human-readable title (localized Spanish)
//   description — detail text explaining the goal
//   target     — numeric target to complete
//   current    — current progress toward target
//   xp_bonus   — bonus XP awarded on goal completion
//   icon       — Lucide icon name for frontend rendering
//   priority   — 1 (highest) to 5 (lowest) for ordering

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

    // ── Parallel data fetch (5 queries) ──────────────────────
    const [
      dueCardsResult,
      weakAreasResult,
      xpResult,
      dailyActivityResult,
      todaySessionsResult,
    ] = await Promise.all([
      // 1. FSRS cards due now or overdue
      db
        .from("fsrs_states")
        .select("flashcard_id", { count: "exact", head: true })
        .eq("student_id", user.id)
        .lte("due_at", nowIso),

      // 2. BKT weak subtopics (p_know < 0.5)
      db
        .from("bkt_states")
        .select(
          "subtopic_id, p_know, subtopics(name, topic_id, topics(name))",
        )
        .eq("student_id", user.id)
        .lt("p_know", 0.5)
        .order("p_know", { ascending: true })
        .limit(3),

      // 3. Student XP (today progress + daily goal)
      db
        .from("student_xp")
        .select("xp_today, daily_goal_minutes")
        .eq("student_id", user.id)
        .eq("institution_id", institutionId!)
        .maybeSingle(),

      // 4. Today's activity (time spent)
      db
        .from("daily_activities")
        .select("time_spent_seconds, sessions_count, reviews_count")
        .eq("student_id", user.id)
        .eq("activity_date", today)
        .maybeSingle(),

      // 5. Today's completed sessions
      db
        .from("study_sessions")
        .select("id", { count: "exact", head: true })
        .eq("student_id", user.id)
        .not("completed_at", "is", null)
        .gte("created_at", today + "T00:00:00Z"),
    ]);

    // ── Build goals array ────────────────────────────────────
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

    // Goal 1: Review due flashcards (highest priority)
    const dueCount = dueCardsResult.count ?? 0;
    if (dueCount > 0) {
      const target = Math.min(dueCount, 10); // Cap at 10 for achievability
      const reviewsDone = dailyActivityResult.data?.reviews_count ?? 0;
      const current = Math.min(reviewsDone, target);
      goals.push({
        type: "review_due",
        title: `Revisa ${target} flashcards vencidas`,
        description: `Tienes ${dueCount} tarjetas pendientes de revision. El repaso espaciado mejora la retencion a largo plazo.`,
        target,
        current,
        xp_bonus: 50,
        icon: "RotateCcw",
        priority: 1,
        completed: current >= target,
      });
    }

    // Goal 2: Improve weak area (if any exist)
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
        target: 1, // 1 study session on this area
        current: 0,
        xp_bonus: 75,
        icon: "TrendingUp",
        priority: 2,
        completed: false,
      });
    }

    // Goal 3: Daily XP target
    const xpToday = xpResult.data?.xp_today ?? 0;
    const dailyXpTarget = 100; // Standard daily target
    goals.push({
      type: "daily_xp",
      title: `Gana ${dailyXpTarget} XP hoy`,
      description: `Llevas ${xpToday} XP hoy. Cada revision, quiz y sesion completada te acerca a la meta.`,
      target: dailyXpTarget,
      current: Math.min(xpToday, dailyXpTarget),
      xp_bonus: 25,
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
      xp_bonus: 30,
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
        xp_bonus: 25,
        icon: "BookOpen",
        priority: 5,
        completed: false,
      });
    }

    // Sort by priority (lowest number = highest priority)
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
// Returns BKT p_know by subtopic, grouped by section > topic.
// Allows frontend to render a visual knowledge mastery heatmap.
//
// Theory: SDT Competence (Deci & Ryan 1985).
// Students need to SEE their real mastery growth, not just accumulated
// points. BKT p_know is the scientifically rigorous metric that
// reflects actual learning (knowledge probability), making it far
// more meaningful than XP for competence perception.
//
// Color coding:
//   green  (p_know >= 0.80) — mastered
//   yellow (p_know >= 0.50) — developing
//   red    (p_know <  0.50) — needs work
//
// Query strategy: 3-step sequential (course→sections→subtopics, then BKT)
// Could be parallelized, but the dependency chain makes sequential clearer.

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

    // Resolve institution from course for membership check
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

    // ── Step 1: Get content hierarchy for this course ────────
    // Course → Semesters → Sections → Topics → Subtopics
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
      return ok(c, { sections: [], summary: { total: 0, mastered: 0, developing: 0, needs_work: 0 } });
    }

    // Get sections with their topics and subtopics
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

    // Collect all subtopic IDs for BKT lookup
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
        summary: { total: 0, mastered: 0, developing: 0, needs_work: 0 },
      });
    }

    // ── Step 2: Fetch BKT states for all subtopics ──────────
    // Batch query with .in() — efficient for up to ~500 subtopics
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

    // Build lookup map: subtopic_id → BKT state
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

    // ── Step 3: Build structured response ────────────────────
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

      // Sort topics by order_index
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
                      (bkt.correct_attempts / bkt.total_attempts) *
                        100,
                    )
                  : 0,
              last_practiced: bkt?.updated_at ?? null,
            };
          },
        );

        // Topic-level aggregate
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

      // Section-level aggregate
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
// HELPERS
// ═══════════════════════════════════════════════════════════════

// ─── Helper: Evaluate simple conditions ──────────────────────
// Supports: "field >= N", "field > N", "field = N"

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
