/**
 * gamification-dispatcher.ts — Post-award badge evaluation with advisory lock
 *
 * Problem: After XP hooks award XP (fire-and-forget), badge evaluation can
 * be triggered by concurrent requests. Two requests for the same student
 * can both evaluate the same badge and cause double XP awards from badge
 * rewards (tryAwardBadge's fresh-check + 23505 guard mitigates the badge
 * insert itself, but the XP award in tryAwardBadge can still double-fire
 * in the window between the fresh-check SELECT and the INSERT).
 *
 * Solution: Use a PostgreSQL advisory lock (per-student) around post-award
 * badge evaluation. If the lock cannot be acquired, skip — another request
 * is already evaluating badges for this student.
 *
 * Advisory lock RPCs:
 *   try_advisory_lock(lock_key BIGINT) → BOOLEAN
 *   advisory_unlock(lock_key BIGINT)   → BOOLEAN
 * (see migration 20260319000009_advisory_lock_wrappers.sql)
 *
 * Lock key derivation:
 *   FNV-1a 32-bit hash of "{studentId}:post_eval" cast to bigint.
 *   Collisions are harmless (worst case: one student's eval is skipped
 *   once, and will run on the next XP event).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { getAdminClient } from "./db.ts";
import { advisoryLockKey, withAdvisoryLock } from "./lib/advisory-lock.ts";

// ─── Post-Award Evaluation ──────────────────────────────────────

/**
 * Trigger badge evaluation for a student after XP is awarded.
 *
 * Acquires a per-student advisory lock to prevent concurrent evaluations.
 * If the lock cannot be acquired (another request is already evaluating),
 * the call is skipped — the concurrent request will cover badge evaluation.
 *
 * Fire-and-forget safe: all errors are caught and logged.
 *
 * @param studentId — Student UUID
 * @param institutionId — Institution UUID for badge context
 */
export function postAwardEvaluation(
  studentId: string,
  institutionId: string,
): void {
  _postAwardEvaluation(studentId, institutionId).catch((e) => {
    console.warn(
      `[Gamification Dispatcher] Unhandled error in postAwardEvaluation:`,
      (e as Error).message,
    );
  });
}

/**
 * Internal async implementation of post-award badge evaluation with
 * advisory lock protection.
 */
export async function _postAwardEvaluation(
  studentId: string,
  institutionId: string,
): Promise<void> {
  const db: SupabaseClient = getAdminClient();
  const lockKey = advisoryLockKey(`${studentId}:post_eval`);

  await withAdvisoryLock(
    db,
    lockKey,
    `post-eval:${studentId}`,
    async () => {
      console.info(
        `[Gamification Dispatcher] Lock acquired for student=${studentId}, ` +
          `lockKey=${lockKey}. Running post-award badge evaluation.`,
      );
      await _evaluateBadgesForStudent(db, studentId, institutionId);
    },
    () => console.info(
      `[Gamification Dispatcher] Lock not acquired for student=${studentId}, ` +
        `lockKey=${lockKey} — another request is already evaluating. Skipping.`,
    ),
  );
}

// ─── Badge Evaluation (mirrors check-badges route logic) ────────

/**
 * Evaluate all unearned badges for a student and award any newly met ones.
 * This is the same logic as POST /gamification/check-badges but called
 * server-side after XP awards instead of from a client request.
 */
async function _evaluateBadgesForStudent(
  db: SupabaseClient,
  studentId: string,
  institutionId: string,
): Promise<void> {
  // Dynamically import to avoid circular dependency with badges.ts
  const { evaluateSimpleCondition, evaluateCountBadge } = await import(
    "./routes/gamification/helpers.ts"
  );
  const { awardXP } = await import("./xp-engine.ts");

  // 1. Fetch all active badge definitions
  const { data: allBadges, error: badgeErr } = await db
    .from("badge_definitions")
    .select("*")
    .eq("is_active", true);

  if (badgeErr) {
    console.warn(
      `[Gamification Dispatcher] badge_definitions fetch failed:`,
      badgeErr.message,
    );
    return;
  }

  // 2. Fetch already earned badges
  const { data: earnedBadges } = await db
    .from("student_badges")
    .select("badge_id")
    .eq("student_id", studentId);

  const earnedIds = new Set(
    (earnedBadges ?? []).map((b: Record<string, unknown>) => b.badge_id),
  );
  const unearnedBadges = (allBadges ?? []).filter(
    (b: Record<string, unknown>) => !earnedIds.has(b.id as string),
  );

  if (unearnedBadges.length === 0) return;

  // 3. Build eval context
  const [xpResult, statsResult] = await Promise.all([
    db
      .from("student_xp")
      .select("total_xp, current_level, xp_today, xp_this_week")
      .eq("student_id", studentId)
      .eq("institution_id", institutionId)
      .maybeSingle(),
    db
      .from("student_stats")
      .select("current_streak, longest_streak, total_reviews, total_sessions")
      .eq("student_id", studentId)
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

  let awarded = 0;

  // ── Phase 1: Criteria-based badges ──
  for (const badge of unearnedBadges) {
    const criteria = badge.criteria as string;
    if (!criteria) continue;

    const conditions = criteria.split(" AND ").map((s: string) => s.trim());
    const allMet = conditions.every((cond: string) =>
      evaluateSimpleCondition(cond, evalContext),
    );

    if (allMet) {
      const didAward = await _tryAwardBadge(db, studentId, institutionId, badge, awardXP);
      if (didAward) awarded++;
    }
  }

  // ── Phase 2: COUNT-based badges ──
  const countBadges = unearnedBadges.filter(
    (b: Record<string, unknown>) =>
      !b.criteria &&
      b.trigger_config &&
      typeof b.trigger_config === "object" &&
      (b.trigger_config as Record<string, unknown>).table,
  );

  if (countBadges.length > 0) {
    const evalResults = await Promise.allSettled(
      countBadges.map(async (badge) => {
        const met = await evaluateCountBadge(
          db,
          studentId,
          badge.trigger_config as { table: string; condition: string; filter?: string },
        );
        return { badge, met };
      }),
    );

    for (const result of evalResults) {
      if (result.status === "fulfilled" && result.value.met) {
        const didAward = await _tryAwardBadge(
          db,
          studentId,
          institutionId,
          result.value.badge,
          awardXP,
        );
        if (didAward) awarded++;
      }
    }
  }

  if (awarded > 0) {
    console.info(
      `[Gamification Dispatcher] Awarded ${awarded} new badge(s) to student=${studentId}.`,
    );
  }
}

// ─── Badge Award Helper ─────────────────────────────────────────

/**
 * Attempt to award a single badge. Mirrors tryAwardBadge from badges.ts
 * with the same fresh-check + 23505 race handling.
 *
 * Returns true if the badge was newly awarded, false otherwise.
 */
async function _tryAwardBadge(
  db: SupabaseClient,
  studentId: string,
  institutionId: string,
  badge: Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
  awardXP: any,
): Promise<boolean> {
  // Fresh check: re-query to prevent stale-read double-awards
  const { count: alreadyEarned } = await db
    .from("student_badges")
    .select("badge_id", { count: "exact", head: true })
    .eq("student_id", studentId)
    .eq("badge_id", badge.id as string);

  if ((alreadyEarned ?? 0) > 0) return false;

  const { error: insertErr } = await db
    .from("student_badges")
    .insert({
      student_id: studentId,
      badge_id: badge.id,
      institution_id: institutionId,
    });

  if (insertErr) {
    // 23505 = unique_violation (concurrent race)
    if (insertErr.code === "23505") return false;
    console.warn(
      `[Gamification Dispatcher] Badge insert failed for "${badge.name}":`,
      insertErr.message,
    );
    return false;
  }

  // Award badge XP reward
  const xpReward = badge.xp_reward as number;
  if (xpReward && xpReward > 0) {
    try {
      await awardXP({
        db,
        studentId,
        institutionId,
        action: `badge_${badge.slug}`,
        xpBase: xpReward,
        sourceType: "badge",
        sourceId: badge.id as string,
      });
    } catch (e) {
      console.warn(
        `[Gamification Dispatcher] XP award for badge ${badge.slug} failed:`,
        (e as Error).message,
      );
    }
  }

  return true;
}

