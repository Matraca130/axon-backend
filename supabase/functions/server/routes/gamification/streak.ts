/**
 * routes/gamification/streak.ts — Streak management
 *
 * AUDIT FIXES:
 *   G-001 — streak_freezes INSERT includes freeze_type + xp_cost
 *   A-004 — streak_repairs INSERT includes institution_id + repair_date
 *   BUG-5 — POST /daily-check-in skips streak XP when streak breaks
 *   BUG-8 — POST /streak-repair restores to longest_streak (intentional)
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import { computeStreakStatus, performDailyCheckIn } from "../../streak-engine.ts";
import { awardXP, XP_TABLE } from "../../xp-engine.ts";
import { FREEZE_COST_XP, MAX_FREEZES, REPAIR_BASE_COST_XP } from "./helpers.ts";

export const streakRoutes = new Hono();

// --- GET /gamification/streak-status ---

streakRoutes.get(`${PREFIX}/gamification/streak-status`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  try {
    const status = await computeStreakStatus(db, user.id, institutionId);
    return ok(c, status);
  } catch (e) {
    return err(c, `Streak status failed: ${(e as Error).message}`, 500);
  }
});

// --- POST /gamification/daily-check-in ---
// BUG-5 FIX: Only awards streak_daily XP if streak did NOT break.

streakRoutes.post(`${PREFIX}/gamification/daily-check-in`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  try {
    const result = await performDailyCheckIn(user.id, institutionId);

    const isAlreadyCheckedIn = result.events.some(
      (e) => e.type === "already_checked_in",
    );
    const streakBroke = result.events.some(
      (e) => e.type === "streak_broken",
    );

    if (!isAlreadyCheckedIn && !streakBroke && XP_TABLE.streak_daily) {
      try {
        await awardXP({
          db: getAdminClient(),
          studentId: user.id,
          institutionId,
          action: "streak_daily",
          xpBase: XP_TABLE.streak_daily,
          sourceType: "streak",
          sourceId: `checkin_${new Date().toISOString().split("T")[0]}`,
          currentStreak: result.streak_status.current_streak,
        });
      } catch (e) {
        console.warn("[Daily Check-in] XP award failed:", (e as Error).message);
      }
    }

    return ok(c, result);
  } catch (e) {
    return err(c, `Daily check-in failed: ${(e as Error).message}`, 500);
  }
});

// --- POST /gamification/streak-freeze/buy ---

streakRoutes.post(`${PREFIX}/gamification/streak-freeze/buy`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const adminDb = getAdminClient();

  const { count: currentFreezes, error: countErr } = await adminDb
    .from("streak_freezes")
    .select("id", { count: "exact", head: true })
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .is("used_on", null);

  if (countErr) {
    return err(c, `Freeze count check failed: ${countErr.message}`, 500);
  }

  if ((currentFreezes ?? 0) >= MAX_FREEZES) {
    return err(
      c,
      `Ya tienes el maximo de ${MAX_FREEZES} streak freezes. Usa uno antes de comprar mas.`,
      400,
    );
  }

  const { data: xpData, error: xpErr } = await adminDb
    .from("student_xp")
    .select("total_xp, streak_freezes_owned")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .maybeSingle();

  if (xpErr) {
    return err(c, `XP check failed: ${xpErr.message}`, 500);
  }

  const totalXp = xpData?.total_xp ?? 0;
  if (totalXp < FREEZE_COST_XP) {
    return err(
      c,
      `No tienes suficiente XP. Necesitas ${FREEZE_COST_XP} XP, tienes ${totalXp}.`,
      400,
    );
  }

  const { error: deductErr } = await adminDb
    .from("student_xp")
    .update({
      total_xp: totalXp - FREEZE_COST_XP,
      streak_freezes_owned: (xpData?.streak_freezes_owned ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("student_id", user.id)
    .eq("institution_id", institutionId);

  if (deductErr) {
    return err(c, `XP deduction failed: ${deductErr.message}`, 500);
  }

  // G-001 FIX: Include freeze_type and xp_cost in INSERT
  const { data: freeze, error: freezeErr } = await adminDb
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
    await adminDb
      .from("student_xp")
      .update({
        total_xp: totalXp,
        streak_freezes_owned: xpData?.streak_freezes_owned ?? 0,
      })
      .eq("student_id", user.id)
      .eq("institution_id", institutionId);

    return err(c, `Freeze creation failed: ${freezeErr.message}`, 500);
  }

  await adminDb.from("xp_transactions").insert({
    student_id: user.id,
    institution_id: institutionId,
    action: "streak_freeze_buy",
    xp_base: -FREEZE_COST_XP,
    xp_final: -FREEZE_COST_XP,
    multiplier: 1,
    source_type: "streak_freeze",
    source_id: freeze.id,
  });

  return ok(c, {
    freeze,
    xp_spent: FREEZE_COST_XP,
    remaining_xp: totalXp - FREEZE_COST_XP,
    freezes_owned: (currentFreezes ?? 0) + 1,
  });
});

// --- POST /gamification/streak-repair ---
// BUG-8 DOC: Restores streak to longest_streak (intentional).

streakRoutes.post(`${PREFIX}/gamification/streak-repair`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const adminDb = getAdminClient();

  const status = await computeStreakStatus(adminDb, user.id, institutionId);

  if (!status.repair_eligible) {
    return err(
      c,
      "Tu racha no es elegible para reparacion. Solo puedes reparar dentro de 48 horas de la ruptura.",
      400,
    );
  }

  const streakToRestore = status.longest_streak;
  const repairCost = REPAIR_BASE_COST_XP + Math.floor(streakToRestore * 10);

  const { data: xpData, error: xpErr } = await adminDb
    .from("student_xp")
    .select("total_xp")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .maybeSingle();

  if (xpErr) {
    return err(c, `XP check failed: ${xpErr.message}`, 500);
  }

  const totalXp = xpData?.total_xp ?? 0;
  if (totalXp < repairCost) {
    return err(
      c,
      `No tienes suficiente XP para reparar. Costo: ${repairCost} XP, tienes: ${totalXp} XP.`,
      400,
    );
  }

  const { error: deductErr } = await adminDb
    .from("student_xp")
    .update({
      total_xp: totalXp - repairCost,
      updated_at: new Date().toISOString(),
    })
    .eq("student_id", user.id)
    .eq("institution_id", institutionId);

  if (deductErr) {
    return err(c, `XP deduction failed: ${deductErr.message}`, 500);
  }

  const today = new Date().toISOString().split("T")[0];
  const { error: statsErr } = await adminDb
    .from("student_stats")
    .update({
      current_streak: streakToRestore,
      last_study_date: today,
      updated_at: new Date().toISOString(),
    })
    .eq("student_id", user.id);

  if (statsErr) {
    await adminDb
      .from("student_xp")
      .update({ total_xp: totalXp })
      .eq("student_id", user.id)
      .eq("institution_id", institutionId);

    return err(c, `Streak restore failed: ${statsErr.message}`, 500);
  }

  // A-004 FIX: Include institution_id and repair_date in INSERT
  const { data: repair, error: repairErr } = await adminDb
    .from("streak_repairs")
    .insert({
      student_id: user.id,
      institution_id: institutionId,
      repair_cost: repairCost,
      previous_streak: streakToRestore,
      repair_date: today,
      repaired_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (repairErr) {
    console.warn("[Streak Repair] Record insert failed:", repairErr.message);
  }

  await adminDb.from("xp_transactions").insert({
    student_id: user.id,
    institution_id: institutionId,
    action: "streak_repair",
    xp_base: -repairCost,
    xp_final: -repairCost,
    multiplier: 1,
    source_type: "streak_repair",
    source_id: repair?.id ?? null,
  });

  return ok(c, {
    repaired: true,
    restored_streak: streakToRestore,
    xp_spent: repairCost,
    remaining_xp: totalXp - repairCost,
  });
});
