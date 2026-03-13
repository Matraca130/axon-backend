/**
 * gamification-dispatcher.ts -- Central gamification event dispatcher
 *
 * Wraps awardXP() with automatic post-award evaluation:
 *   1. Award XP (primary, always executed)
 *   2. Fire-and-forget: evaluate badges + challenges
 *
 * INFINITE LOOP PREVENTION:
 *   When a badge is awarded, its XP reward calls awardXP() with
 *   skipPostEval=true, which skips step 2. This breaks the cycle:
 *     hook -> dispatcher -> awardXP -> badge eval -> badge XP (skip) -> done
 *
 * PERFORMANCE:
 *   Post-eval is Promise.allSettled -- never blocks the response.
 *   Badge/challenge evaluation is lightweight (2 queries + loop).
 *   Worst case: ~50ms overhead per XP award (acceptable for f&f).
 *
 * CONTRACT COMPLIANCE:
 *   S4.3 -- Fire-and-forget pattern preserved
 *   S10  -- No double-counting: dispatcher doesn't modify XP amounts
 */

import { awardXP, type AwardXPParams, type AwardResult } from "./xp-engine.ts";
import { evaluateAndAwardBadges } from "./badge-engine.ts";
import { evaluateChallenge, type ChallengeProgress } from "./challenge-engine.ts";
import { getAdminClient } from "./db.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js";

// --- Types ---

export interface DispatchParams extends AwardXPParams {
  /** Skip post-award evaluation (prevents infinite loops) */
  skipPostEval?: boolean;
  /** User-scoped DB client for reads (optional, falls back to admin) */
  userDb?: SupabaseClient;
}

export interface DispatchResult {
  xp: AwardResult | null;
  postEvalTriggered: boolean;
}

// --- Core Dispatcher ---

/**
 * Award XP and trigger automatic badge/challenge evaluation.
 *
 * This is the PRIMARY entry point for all XP-granting actions.
 * Hooks should call this instead of awardXP() directly.
 *
 * @param params -- Same as AwardXPParams + skipPostEval flag
 * @returns XP award result (post-eval is fire-and-forget)
 */
export async function dispatchGamificationEvent(
  params: DispatchParams,
): Promise<DispatchResult> {
  const { skipPostEval = false, userDb, ...xpParams } = params;

  // Step 1: Award XP (primary)
  const xpResult = await awardXP(xpParams);

  // Step 2: Fire-and-forget post-award evaluation
  if (!skipPostEval && xpResult) {
    const adminDb = xpParams.db;
    const readDb = userDb ?? adminDb;

    // Don't await -- fire and forget
    _postAwardEvaluation(
      adminDb,
      readDb,
      xpParams.studentId,
      xpParams.institutionId,
    ).catch((e) =>
      console.warn("[Dispatcher] Post-eval error:", (e as Error).message),
    );

    return { xp: xpResult, postEvalTriggered: true };
  }

  return { xp: xpResult, postEvalTriggered: false };
}

// --- Post-Award Evaluation (internal) ---

async function _postAwardEvaluation(
  adminDb: SupabaseClient,
  userDb: SupabaseClient,
  studentId: string,
  institutionId: string,
): Promise<void> {
  const results = await Promise.allSettled([
    // Badge evaluation (with skipXPAward=true to prevent loops)
    evaluateAndAwardBadges(adminDb, userDb, studentId, institutionId, true),
    // Challenge progress evaluation
    _evaluateChallengesForStudent(adminDb, userDb, studentId, institutionId),
  ]);

  // Log results for debugging
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("[Dispatcher] Post-eval task failed:", result.reason);
    }
  }
}

/**
 * Evaluate active challenges for a student.
 * Extracted for use by the dispatcher (was inline in challenges.ts route).
 */
async function _evaluateChallengesForStudent(
  adminDb: SupabaseClient,
  userDb: SupabaseClient,
  studentId: string,
  institutionId: string,
): Promise<{ checked: number; completed: number }> {
  const now = new Date().toISOString();

  // Get active challenges
  const { data: activeChallenges } = await userDb
    .from("student_challenges")
    .select("id, challenge_slug, criteria_field, criteria_op, criteria_value")
    .eq("student_id", studentId)
    .eq("institution_id", institutionId)
    .is("completed_at", null)
    .is("claimed_at", null)
    .gt("expires_at", now);

  if (!activeChallenges || activeChallenges.length === 0) {
    return { checked: 0, completed: 0 };
  }

  // Get context (2 queries only thanks to PR #108 counters)
  const [xpResult, statsResult] = await Promise.all([
    userDb
      .from("student_xp")
      .select("xp_today, xp_this_week, total_xp")
      .eq("student_id", studentId)
      .eq("institution_id", institutionId)
      .maybeSingle(),
    userDb
      .from("student_stats")
      .select("current_streak, total_reviews, reviews_today, sessions_today, correct_streak")
      .eq("student_id", studentId)
      .maybeSingle(),
  ]);

  const context: Record<string, number> = {
    xp_today: (xpResult.data?.xp_today as number) ?? 0,
    xp_this_week: (xpResult.data?.xp_this_week as number) ?? 0,
    total_xp: (xpResult.data?.total_xp as number) ?? 0,
    current_streak: (statsResult.data?.current_streak as number) ?? 0,
    total_reviews: (statsResult.data?.total_reviews as number) ?? 0,
    reviews_today: (statsResult.data?.reviews_today as number) ?? 0,
    sessions_today: (statsResult.data?.sessions_today as number) ?? 0,
    correct_streak: (statsResult.data?.correct_streak as number) ?? 0,
  };

  let completedCount = 0;

  for (const challenge of activeChallenges) {
    const progress: ChallengeProgress = {
      challenge_slug: challenge.challenge_slug as string,
      criteria_field: challenge.criteria_field as string,
      criteria_op: challenge.criteria_op as string,
      criteria_value: challenge.criteria_value as number,
      current_value: context[challenge.criteria_field as string] ?? 0,
    };

    const evalResult = evaluateChallenge(progress);

    if (evalResult.completed) {
      completedCount++;
      await adminDb
        .from("student_challenges")
        .update({
          current_value: progress.current_value,
          progress_pct: 100,
          completed_at: now,
        })
        .eq("id", challenge.id)
        .is("completed_at", null); // Idempotent guard
    } else {
      // Update progress without completing
      await adminDb
        .from("student_challenges")
        .update({
          current_value: progress.current_value,
          progress_pct: evalResult.progress_pct,
        })
        .eq("id", challenge.id);
    }
  }

  if (completedCount > 0) {
    console.log(
      `[Dispatcher] Auto-completed ${completedCount}/${activeChallenges.length} challenges for ${studentId}`,
    );
  }

  return { checked: activeChallenges.length, completed: completedCount };
}
