/**
 * routes-gamification.tsx — Gamification endpoints for Axon v4.4
 *
 * Custom routes (not CRUD factory):
 *   GET  /gamification/profile      — XP, level, badges, streak
 *   GET  /gamification/xp-history   — Paginated XP transactions
 *   POST /gamification/check-badges — Evaluate & award pending badges
 *   GET  /gamification/leaderboard  — Weekly leaderboard (MV + fallback)
 *
 * Pattern: Same as routes-study-queue.tsx
 * Response: ok(c, data) / err(c, message, status)
 *
 * CONTRACT COMPLIANCE:
 *   §2.1 — authenticate(c) + instanceof Response check
 *   §2.2 — ok(c, data) and err(c, msg, status)
 *   §2.3 — Flat routes with query params
 *   §5.4 — institution_id via query param, validated
 *   §6.9 — requireInstitutionRole(ALL_ROLES) for reads
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

// ─── GET /gamification/profile ───────────────────────────────
// Returns unified gamification profile: XP, level, badges, streak.
// Parallel fetch for performance (same pattern as study-queue).

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
          .single(),
        db
          .from("student_badges")
          .select("*, badge_definitions(*)")
          .eq("student_id", user.id)
          .eq("institution_id", institutionId!),
        db
          .from("student_stats")
          .select(
            "current_streak, longest_streak, total_reviews, total_time_seconds",
          )
          .eq("student_id", user.id)
          .single(),
        db
          .from("xp_transactions")
          .select("action, xp_final, bonus_type, created_at")
          .eq("student_id", user.id)
          .eq("institution_id", institutionId!)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

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
