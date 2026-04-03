/**
 * finals-badge-hooks.ts — afterWrite hook for finals badge evaluation
 *
 * Wired to the study_plans CRUD factory afterWrite. Evaluates:
 *   - Sobreviviente de Finales: 3+ finals plans for this student
 *   - Cero Panico: plan created 15+ days before linked exam
 *
 * Maraton de Estudio is handled by pg_cron (migration 20260402000006).
 */

import type { AfterWriteParams } from "./crud-factory.ts";
import { getAdminClient } from "./db.ts";
import { awardXP } from "./xp-engine.ts";
import { isInFinalsPeriod } from "./lib/finals-detector.ts";

/**
 * Award a badge by slug. Checks if already earned, inserts, awards XP.
 * Returns true if newly awarded, false if already earned or error.
 */
async function awardBadgeBySlug(
  db: ReturnType<typeof getAdminClient>,
  studentId: string,
  institutionId: string,
  badgeSlug: string,
): Promise<boolean> {
  // Find badge definition by slug
  const { data: badge } = await db
    .from("badge_definitions")
    .select("id, slug, xp_reward")
    .eq("slug", badgeSlug)
    .eq("is_active", true)
    .single();

  if (!badge) return false;

  // Award (23505 duplicate handling below covers already-earned case)
  const { error } = await db
    .from("student_badges")
    .insert({
      student_id: studentId,
      badge_id: badge.id,
      institution_id: institutionId,
    });

  if (error) {
    if (error.code === "23505") return false; // duplicate
    console.error(`[Finals Badges] Insert failed for "${badgeSlug}":`, error.message);
    return false;
  }

  // Award XP
  if (badge.xp_reward && badge.xp_reward > 0) {
    try {
      await awardXP({
        db,
        studentId,
        institutionId,
        action: `badge_${badge.slug}`,
        xpBase: badge.xp_reward,
        sourceType: "badge",
        sourceId: badge.id,
      });
    } catch (e) {
      console.error(`[Finals Badges] XP for ${badgeSlug} failed:`, (e as Error).message);
    }
  }

  return true;
}

/**
 * Resolve institution_id from a study plan's course_id.
 */
async function resolveInstitutionFromPlan(
  db: ReturnType<typeof getAdminClient>,
  courseId: string,
): Promise<string | null> {
  const { data } = await db
    .from("courses")
    .select("institution_id")
    .eq("id", courseId)
    .single();
  return data?.institution_id ?? null;
}

/**
 * afterWrite hook for study_plans.
 * Evaluates Sobreviviente de Finales and Cero Panico badges on plan creation.
 */
export function xpHookForFinalsBadges(params: AfterWriteParams): void {
  if (params.action !== "create") return;

  const { row, userId } = params;
  const isFinalsPlan = row.is_finals_plan === true;
  const examEventId = row.exam_event_id as string | null;
  const courseId = row.course_id as string | null;

  // Only evaluate if this is a finals-related plan
  if (!isFinalsPlan && !examEventId) return;

  (async () => {
    try {
      const db = getAdminClient();

      // Resolve institution
      if (!courseId) return;
      const institutionId = await resolveInstitutionFromPlan(db, courseId);
      if (!institutionId) return;

      // --- Sobreviviente de Finales: 3+ finals plans ---
      if (isFinalsPlan) {
        // Verify we're actually in a finals period
        const inFinals = await isInFinalsPeriod(db, institutionId);
        if (inFinals) {
          const { count } = await db
            .from("study_plans")
            .select("id", { count: "exact", head: true })
            .eq("student_id", userId)
            .eq("is_finals_plan", true);

          if ((count ?? 0) >= 3) {
            await awardBadgeBySlug(db, userId, institutionId, "sobreviviente_de_finales");
          }
        }
      }

      // --- Cero Panico: plan created 15+ days before exam ---
      if (examEventId) {
        const { data: examEvent } = await db
          .from("exam_events")
          .select("date")
          .eq("id", examEventId)
          .single();

        if (examEvent?.date) {
          const examDate = new Date(examEvent.date);
          const now = new Date();
          now.setHours(0, 0, 0, 0);
          const daysBeforeExam = Math.floor(
            (examDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );
          if (daysBeforeExam >= 15) {
            await awardBadgeBySlug(db, userId, institutionId, "cero_panico");
          }
        }
      }
    } catch (e) {
      console.warn("[Finals Badges] hook error:", (e as Error).message);
    }
  })();
}
