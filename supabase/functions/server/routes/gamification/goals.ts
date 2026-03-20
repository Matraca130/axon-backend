/**
 * routes/gamification/goals.ts — Goals, daily goal, onboarding
 *
 * AUDIT FIXES:
 *   G-003 — POST /goals/complete anti-duplicate protection
 *   BUG-2 — PUT /daily-goal uses getAdminClient()
 *   B-001 — daily_goal -> daily_goal_minutes (matches DB column)
 *   B-004 — onboarding daily_goal -> daily_goal_minutes
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid, isNonNegInt } from "../../validate.ts";
import { requireInstitutionRole, isDenied, ALL_ROLES } from "../../auth-helpers.ts";
import { awardXP } from "../../xp-engine.ts";
import { GOAL_BONUS_XP } from "./helpers.ts";

export const goalRoutes = new Hono();

// --- PUT /gamification/daily-goal ---
// BUG-2 FIX: Uses getAdminClient() to bypass RLS on student_xp.
// B-001 FIX: Column is daily_goal_minutes (not daily_goal).
goalRoutes.put(`${PREFIX}/gamification/daily-goal`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const institutionId = body.institution_id as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  // ACCESS-004 FIX: Verify caller has membership in this institution
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  // Accept both daily_goal and daily_goal_minutes from frontend
  const dailyGoal = body.daily_goal_minutes ?? body.daily_goal;
  if (!isNonNegInt(dailyGoal)) {
    return err(c, "daily_goal_minutes must be a non-negative integer", 400);
  }

  if ((dailyGoal as number) < 5 || (dailyGoal as number) > 120) {
    return err(c, "daily_goal_minutes must be between 5 and 120", 400);
  }

  const adminDb = getAdminClient();

  // B-001 FIX: Use daily_goal_minutes (actual DB column name)
  const { data, error } = await adminDb
    .from("student_xp")
    .upsert(
      {
        student_id: user.id,
        institution_id: institutionId,
        daily_goal_minutes: dailyGoal as number,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "student_id,institution_id" },
    )
    .select()
    .single();

  if (error) {
    return safeErr(c, "Update daily goal", error);
  }

  return ok(c, data);
});

// --- POST /gamification/goals/complete ---
// G-003 FIX: Anti-duplicate check prevents claiming same goal twice per day
goalRoutes.post(`${PREFIX}/gamification/goals/complete`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const institutionId = body.institution_id as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  // ACCESS-004 FIX: Verify caller has membership in this institution
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const goalType = body.goal_type as string;
  if (!goalType || !GOAL_BONUS_XP[goalType]) {
    const validTypes = Object.keys(GOAL_BONUS_XP).join(", ");
    return err(
      c,
      `goal_type must be one of: ${validTypes}`,
      400,
    );
  }

  const bonusXp = GOAL_BONUS_XP[goalType];
  const today = new Date().toISOString().split("T")[0];
  const sourceId = `${goalType}_${today}`;

  // G-003 FIX: Check if this goal was already claimed today
  const adminDb = getAdminClient();
  const { count: existing, error: checkErr } = await adminDb
    .from("xp_transactions")
    .select("id", { count: "exact", head: true })
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .eq("source_type", "goal")
    .eq("source_id", sourceId);

  if (checkErr) {
    return safeErr(c, "Goal check", checkErr);
  }

  if ((existing ?? 0) > 0) {
    return err(c, `Goal '${goalType}' ya fue completado hoy.`, 409);
  }

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
    return safeErr(c, "Goal completion", e instanceof Error ? e : null);
  }
});

// --- POST /gamification/onboarding ---
// B-004 FIX: Uses daily_goal_minutes (matches DB column)
goalRoutes.post(`${PREFIX}/gamification/onboarding`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const institutionId = body.institution_id as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  // ACCESS-004 FIX: Verify caller has membership in this institution
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const adminDb = getAdminClient();

  const { data: existing } = await adminDb
    .from("student_xp")
    .select("student_id")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .maybeSingle();

  if (existing) {
    return ok(c, { message: "Already onboarded", already_exists: true });
  }

  // B-004 FIX: daily_goal_minutes (not daily_goal), default 10 matches DB
  const { error: xpErr } = await adminDb
    .from("student_xp")
    .insert({
      student_id: user.id,
      institution_id: institutionId,
      total_xp: 0,
      xp_today: 0,
      xp_this_week: 0,
      current_level: 1,
      daily_goal_minutes: 10,
      streak_freezes_owned: 0,
    });

  if (xpErr) {
    return safeErr(c, "Onboarding XP init", xpErr);
  }

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
