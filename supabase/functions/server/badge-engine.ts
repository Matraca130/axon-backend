/**
 * badge-engine.ts -- Badge evaluation logic extracted from routes
 *
 * Provides reusable badge evaluation for:
 *   1. POST /check-badges route handler (explicit check)
 *   2. gamification-dispatcher.ts (automatic post-XP check)
 *
 * Separates PURE evaluation from DB operations:
 *   - evaluateBadgeCriteria() -- pure, testable
 *   - evaluateAndAwardBadges() -- DB-aware, used by route + dispatcher
 *
 * TIER SUPPORT (PR #110 ready):
 *   - Evaluation respects tier ordering: bronze < silver < gold < platinum
 *   - Non-tiered badges (tier='none') evaluated independently
 *   - All qualifying tiers awarded in one pass (Duolingo model)
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { evaluateSimpleCondition } from "./routes/gamification/helpers.ts";
import { awardXP } from "./xp-engine.ts";

// --- Types ---

export interface BadgeEvalContext {
  total_xp: number;
  current_level: number;
  xp_today: number;
  xp_this_week: number;
  current_streak: number;
  longest_streak: number;
  total_reviews: number;
  total_sessions: number;
  reviews_today: number;
  sessions_today: number;
  correct_streak: number;
  [key: string]: unknown;
}

export interface BadgeEvalResult {
  new_badges: Array<Record<string, unknown>>;
  checked: number;
  awarded: number;
}

// --- Tier ordering ---

export const TIER_ORDER: Record<string, number> = {
  none: 0,
  bronze: 1,
  silver: 2,
  gold: 3,
  platinum: 4,
};

/**
 * Check if a student has earned the prerequisite tier for a tiered badge.
 * Non-tiered badges (tier='none') always pass.
 * Bronze tier always passes (it's the first tier).
 */
export function hasPrerequisiteTier(
  badgeTier: string,
  achievementGroup: string | null,
  earnedBadges: Map<string, { tier: string; achievement_group: string | null }>,
): boolean {
  if (!badgeTier || badgeTier === "none" || badgeTier === "bronze") return true;
  if (!achievementGroup) return true;

  const prerequisiteTiers: Record<string, string> = {
    silver: "bronze",
    gold: "silver",
    platinum: "gold",
  };

  const requiredTier = prerequisiteTiers[badgeTier];
  if (!requiredTier) return true;

  // Check if student has the prerequisite tier for this achievement group
  for (const [, earned] of earnedBadges) {
    if (
      earned.achievement_group === achievementGroup &&
      earned.tier === requiredTier
    ) {
      return true;
    }
  }

  return false;
}

// --- Pure evaluation ---

/**
 * Evaluate badge criteria against student context.
 * Pure function -- no DB access.
 *
 * @param criteria -- Criteria string (e.g. "total_xp >= 500 AND current_streak >= 3")
 * @param context -- Student data context
 * @returns true if all criteria conditions are met
 */
export function evaluateBadgeCriteria(
  criteria: string,
  context: BadgeEvalContext,
): boolean {
  if (!criteria) return false;

  const conditions = criteria.split(" AND ").map((s: string) => s.trim());
  return conditions.every((cond: string) =>
    evaluateSimpleCondition(cond, context as Record<string, unknown>),
  );
}

// --- DB-aware evaluation ---

/**
 * Evaluate all unearned badges for a student and award qualifying ones.
 * Used by both POST /check-badges and the gamification dispatcher.
 *
 * @param adminDb -- Admin Supabase client (bypasses RLS)
 * @param userDb -- User-scoped Supabase client (for reads)
 * @param studentId -- Student UUID
 * @param institutionId -- Institution UUID
 * @param skipXPAward -- If true, don't award badge XP (prevents loops)
 */
export async function evaluateAndAwardBadges(
  adminDb: SupabaseClient,
  userDb: SupabaseClient,
  studentId: string,
  institutionId: string,
  skipXPAward: boolean = false,
): Promise<BadgeEvalResult> {
  // Step 1: Get all active badge definitions
  const { data: allBadges, error: badgeErr } = await adminDb
    .from("badge_definitions")
    .select("*")
    .eq("is_active", true);

  if (badgeErr || !allBadges) {
    console.warn("[Badge Engine] Failed to fetch badge definitions:", badgeErr?.message);
    return { new_badges: [], checked: 0, awarded: 0 };
  }

  // Step 2: Get student's earned badges
  const { data: earnedBadgesRaw } = await userDb
    .from("student_badges")
    .select("badge_id")
    .eq("student_id", studentId);

  const earnedIds = new Set(
    (earnedBadgesRaw ?? []).map((b: Record<string, unknown>) => b.badge_id as string),
  );

  // Build earned map with tier info for tier prerequisite checking
  const earnedMap = new Map<string, { tier: string; achievement_group: string | null }>();
  for (const badge of allBadges) {
    if (earnedIds.has(badge.id as string)) {
      earnedMap.set(badge.id as string, {
        tier: (badge.tier as string) ?? "none",
        achievement_group: (badge.achievement_group as string) ?? null,
      });
    }
  }

  const unearnedBadges = allBadges.filter(
    (b: Record<string, unknown>) => !earnedIds.has(b.id as string),
  );

  if (unearnedBadges.length === 0) {
    return { new_badges: [], checked: 0, awarded: 0 };
  }

  // Step 3: Get student data for evaluation (parallel)
  const [xpResult, statsResult] = await Promise.all([
    userDb
      .from("student_xp")
      .select("total_xp, current_level, xp_today, xp_this_week")
      .eq("student_id", studentId)
      .eq("institution_id", institutionId)
      .maybeSingle(),
    userDb
      .from("student_stats")
      .select("current_streak, longest_streak, total_reviews, total_sessions, reviews_today, sessions_today, correct_streak")
      .eq("student_id", studentId)
      .maybeSingle(),
  ]);

  const evalContext: BadgeEvalContext = {
    total_xp: (xpResult.data?.total_xp as number) ?? 0,
    current_level: (xpResult.data?.current_level as number) ?? 1,
    xp_today: (xpResult.data?.xp_today as number) ?? 0,
    xp_this_week: (xpResult.data?.xp_this_week as number) ?? 0,
    current_streak: (statsResult.data?.current_streak as number) ?? 0,
    longest_streak: (statsResult.data?.longest_streak as number) ?? 0,
    total_reviews: (statsResult.data?.total_reviews as number) ?? 0,
    total_sessions: (statsResult.data?.total_sessions as number) ?? 0,
    reviews_today: (statsResult.data?.reviews_today as number) ?? 0,
    sessions_today: (statsResult.data?.sessions_today as number) ?? 0,
    correct_streak: (statsResult.data?.correct_streak as number) ?? 0,
  };

  // Step 4: Evaluate each unearned badge
  const newBadges: Array<Record<string, unknown>> = [];

  // Sort by tier order so bronze is evaluated before silver, etc.
  const sortedBadges = [...unearnedBadges].sort((a, b) => {
    const tierA = TIER_ORDER[(a.tier as string) ?? "none"] ?? 0;
    const tierB = TIER_ORDER[(b.tier as string) ?? "none"] ?? 0;
    return tierA - tierB;
  });

  for (const badge of sortedBadges) {
    const criteria = badge.criteria as string;
    if (!criteria) continue;

    // Check tier prerequisite
    const badgeTier = (badge.tier as string) ?? "none";
    const achievementGroup = (badge.achievement_group as string) ?? null;

    if (!hasPrerequisiteTier(badgeTier, achievementGroup, earnedMap)) {
      continue;
    }

    // Evaluate criteria
    if (!evaluateBadgeCriteria(criteria, evalContext)) {
      continue;
    }

    // Award badge
    const { error: insertErr } = await adminDb
      .from("student_badges")
      .insert({ student_id: studentId, badge_id: badge.id });

    if (!insertErr) {
      newBadges.push(badge);

      // Update earned map for tier progression within same pass
      earnedMap.set(badge.id as string, { tier: badgeTier, achievement_group: achievementGroup });

      // Award badge XP reward (if defined and not skipped)
      const xpReward = badge.xp_reward as number;
      if (!skipXPAward && xpReward && xpReward > 0) {
        try {
          await awardXP({
            db: adminDb,
            studentId,
            institutionId,
            action: `badge_${badge.slug}`,
            xpBase: xpReward,
            sourceType: "badge",
            sourceId: badge.id as string,
          });
        } catch (e) {
          console.warn(`[Badge Engine] XP award for ${badge.slug} failed:`, (e as Error).message);
        }
      }
    }
  }

  return {
    new_badges: newBadges,
    checked: unearnedBadges.length,
    awarded: newBadges.length,
  };
}
