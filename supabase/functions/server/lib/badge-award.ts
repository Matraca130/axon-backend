/**
 * lib/badge-award.ts — Shared badge award helper
 *
 * Centralizes the insert + XP reward logic that was duplicated in:
 *   - routes/gamification/badges.ts  (tryAwardBadge)
 *   - gamification-dispatcher.ts     (_tryAwardBadge)
 *
 * Handles:
 *   - Fresh DB check to prevent double-awards on concurrent requests
 *   - student_badges INSERT with institution_id (G-002)
 *   - 23505 unique_violation race handling
 *   - XP reward for badge
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { awardXP } from "../xp-engine.ts";

/**
 * Attempt to award a single badge to a student.
 *
 * Performs a fresh DB check before insert to guard against stale reads
 * in concurrent requests. Handles 23505 unique_violation gracefully.
 *
 * @returns true if the badge was newly awarded, false if already earned or insert failed.
 */
export async function tryAwardBadge(
  db: SupabaseClient,
  studentId: string,
  institutionId: string,
  badge: Record<string, unknown>,
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
      `[Badge Award] Insert failed for "${badge.name}":`,
      insertErr.message,
    );
    return false;
  }

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
        `[Badge Award] XP award for badge ${badge.slug} failed:`,
        (e as Error).message,
      );
    }
  }

  return true;
}
