/**
 * routes/gamification/goals.ts — Goals, daily goal, onboarding
 *
 * Endpoints:
 *   PUT  /gamification/daily-goal     — Update daily XP goal target
 *   POST /gamification/goals/complete  — Mark a goal as completed, award bonus XP
 *   POST /gamification/onboarding      — Initialize student gamification profile
 *
 * BUG-2 FIX: PUT /daily-goal now uses getAdminClient() instead of
 *   user-scoped `db`, which was failing due to RLS policies on
 *   student_xp (students can read but not write their own XP).
 *
 * AUDIT FIXES (PR #113):
 *   G-010 — POST /goals/complete now checks for duplicate completion per day
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX, getAdminClient } from "../../db.ts";
import { isUuid, isNonNegInt } from "../../validate.ts";
import { awardXP } from "../../xp-engine.ts";
import { GOAL_BONUS_XP } from "./helpers.ts";

export const goalRoutes = new Hono();

// ─── PUT /gamification/daily-goal ───────────────────────────
// BUG-2 FIX: Uses getAdminClient() to bypass RLS on student_xp.
// The user-scoped `db` client was rejected by RLS policies because
// students can SELECT but not UPDATE their own student_xp row.

goalRoutes.put(`${PREFIX}/gamification/daily-goal`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const institutionId = body.institution_id as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const dailyGoal = body.daily_goal;
  if (!isNonNegInt(dailyGoal)) {
    return err(c, "daily_goal must be a non-negative integer", 400);
  }

  // Validate reasonable range (10-1000 XP)
  if ((dailyGoal as number) < 10 || (dailyGoal as number) > 1000) {
    return err(c, "daily_goal must be between 10 and 1000", 400);
  }

  // BUG-2 FIX: Use admin client to bypass RLS
  const adminDb = getAdminClient();

  const { data, error } = await adminDb
    .from("student_xp")
    .upsert(
      {
        student_id: user.id,
        institution_id: institutionId,
        daily_goal: dailyGoal as number,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "student_id,institution_id" },
    )
    .select()
    .single();

  if (error) {
    return err(c, `Update daily goal failed: ${error.message}`, 500);
  }

  return ok(c, data);
});

// ─── POST /gamification/goals/complete ──────────────────────
// G-010 FIX: Check for duplicate goal completion on the same day
// to prevent XP farming via repeated calls.

goalRoutes.post(`${PREFIX}/gamification/goals/complete`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const institutionId = body.institution_id as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const goalType = body.goal_type as string;
  if (!goalType || !GOAL_BONUS_XP[goalType]) {
    const validTypes = Object.keys(GOAL_BONUS_XP).join(", ");
    return err(
      c,
      `goal_type must be one of: ${validTypes}`,
      400,
    );
  }

  // G-010 FIX: Check for duplicate goal completion today
  // source_id format is "goalType_YYYY-MM-DD", so we can check
  // if this exact combination already exists in xp_transactions.
  const today = new Date().toISOString().split("T")[0];
  const sourceId = `${goalType}_${today}`;

  const adminDb = getAdminClient();
  const { count: existingCount } = await adminDb
    .from("xp_transactions")
    .select("id", { count: "exact", head: true })
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .eq("source_id", sourceId);

  if ((existingCount ?? 0) > 0) {
    return err(
      c,
      `Ya completaste el objetivo '${goalType}' hoy. Vuelve manana!`,
      409,
    );
  }

  const bonusXp = GOAL_BONUS_XP[goalType];

  try {
    const result = await awardXP({
      db: adminDb,
      studentId: user.id,
      institutionId,
      action: `goal_${goalType}`,
      xpBase: bonusXp,
      sourceType: "goal",
      sourceId,
    });

    return ok(c, {
      goal_type: goalType,
      xp_awarded: result?.xp_awarded ?? bonusXp,
      bonus_type: result?.bonus_type ?? null,
    });
  } catch (e) {
    return err(c, `Goal completion failed: ${(e as Error).message}`, 500);
  }
});

// ─── POST /gamification/onboarding ──────────────────────────

goalRoutes.post(`${PREFIX}/gamification/onboarding`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const institutionId = body.institution_id as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const adminDb = getAdminClient();

  // Check if already onboarded (idempotent)
  const { data: existing } = await adminDb
    .from("student_xp")
    .select("student_id")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .maybeSingle();

  if (existing) {
    return ok(c, { message: "Already onboarded", already_exists: true });
  }

  // Initialize student_xp row
  const { error: xpErr } = await adminDb
    .from("student_xp")
    .insert({
      student_id: user.id,
      institution_id: institutionId,
      total_xp: 0,
      xp_today: 0,
      xp_this_week: 0,
      current_level: 1,
      daily_goal: 50,
      streak_freezes_owned: 0,
    });

  if (xpErr) {
    return err(c, `Onboarding XP init failed: ${xpErr.message}`, 500);
  }

  // Initialize student_stats row (upsert to avoid conflict)
  const { error: statsErr } = await adminDb
    .from("student_stats")
    .upsert(
      {
        student_id: user.id,
        current_streak: 0,
        longest_streak: 0,
        total_reviews: 0,
        total_time_seconds: 0,
        total_sessions: 0,
        last_study_date: null,
      },
      { onConflict: "student_id" },
    );

  if (statsErr) {
    console.warn(
      "[Onboarding] student_stats init failed (may already exist):",
      statsErr.message,
    );
  }

  return ok(c, {
    message: "Gamification profile initialized",
    already_exists: false,
  }, 201);
});
