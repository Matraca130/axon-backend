/**
 * routes/gamification/streak.ts — Streak management
 *
 * AUDIT FIXES:
 *   G-001 — streak_freezes INSERT includes freeze_type + xp_cost
 *   A-004 — streak_repairs INSERT includes institution_id + repair_date
 *   BUG-5 — POST /daily-check-in skips streak XP when streak breaks
 *   BUG-8 — POST /streak-repair restores to longest_streak (intentional)
 *
 * CONCURRENCY FIXES:
 *   C-002 — streak-repair: advisory lock prevents concurrent double-spend
 *   C-003 — streak-freeze fallback: advisory lock prevents concurrent double-spend
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
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
    return safeErr(c, "Streak status", e instanceof Error ? e : null);
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
        console.error("[Daily Check-in] XP award failed:", (e as Error).message);
      }
    }

    return ok(c, result);
  } catch (e) {
    return safeErr(c, "Daily check-in", e instanceof Error ? e : null);
  }
});

// --- POST /gamification/streak-freeze/buy ---
// Primary: atomic SQL RPC (buy_streak_freeze) — prevents race condition double-spend.
// Fallback: original read-then-write JS pattern if RPC not yet deployed.

streakRoutes.post(`${PREFIX}/gamification/streak-freeze/buy`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  const adminDb = getAdminClient();

  // --- Primary path: atomic SQL RPC ---
  try {
    const { data, error: rpcErr } = await adminDb.rpc("buy_streak_freeze", {
      p_student_id: user.id,
      p_institution_id: institutionId,
      p_cost: FREEZE_COST_XP,
    });

    if (!rpcErr && data) {
      const result = data as Record<string, unknown>;

      if (result.error === "max_freezes_reached") {
        return err(
          c,
          `Ya tienes el maximo de ${result.max_freezes} streak freezes. Usa uno antes de comprar mas.`,
          400,
        );
      }
      if (result.error === "insufficient_xp") {
        return err(
          c,
          `No tienes suficiente XP. Necesitas ${FREEZE_COST_XP} XP, tienes ${result.balance}.`,
          400,
        );
      }

      return ok(c, {
        freeze: { id: result.freeze_id },
        xp_spent: result.xp_spent,
        remaining_xp: result.remaining_xp,
        freezes_owned: result.freezes_owned,
      });
    }

    // RPC failed — fall through to JS fallback
    if (rpcErr) {
      console.error("[Streak Freeze] RPC failed, falling back to JS:", rpcErr.message);
    }
  } catch (e) {
    console.error("[Streak Freeze] RPC exception, falling back to JS:", (e as Error).message);
  }

  // --- Fallback path: read-then-write with advisory lock (C-003) ---
  // Advisory lock serializes concurrent freeze-buy requests per student.
  const lockKey = Math.abs(hashCode(user.id + ":streak_freeze"));
  const { data: lockAcquired } = await adminDb.rpc("try_advisory_lock", {
    lock_key: lockKey,
  });

  if (!lockAcquired) {
    return err(c, "Otra operacion de compra esta en progreso. Intenta de nuevo.", 409);
  }

  try {
    const { count: currentFreezes, error: countErr } = await adminDb
      .from("streak_freezes")
      .select("id", { count: "exact", head: true })
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .is("used_on", null);

    if (countErr) {
      return safeErr(c, "Freeze count check", countErr);
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
      return safeErr(c, "XP check", xpErr);
    }

    const totalXp = xpData?.total_xp ?? 0;
    if (totalXp < FREEZE_COST_XP) {
      return err(
        c,
        `No tienes suficiente XP. Necesitas ${FREEZE_COST_XP} XP, tienes ${totalXp}.`,
        400,
      );
    }

    // RPC-ONLY RULE NOTE:
    //   The primary path for this endpoint is the atomic `buy_streak_freeze`
    //   RPC (see above, which handles UPDATE student_xp + INSERT
    //   xp_transactions in a single transaction). This fallback only runs
    //   when the RPC is not deployed / errors out.
    //
    //   awardXP() / award_xp RPC reject xpBase <= 0, so they cannot be used
    //   for deductions. There is no dedicated `deduct_xp` RPC yet.
    //
    //   TODO: Create a `deduct_xp` RPC (mirror of award_xp) and replace this
    //   manual UPDATE + xp_transactions INSERT. Until then, we defer the
    //   streak_freezes INSERT until after the XP deduction succeeds and
    //   roll back on failure to preserve transactional safety.
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
      return safeErr(c, "XP deduction", deductErr);
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

      return safeErr(c, "Freeze creation", freezeErr);
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
  } finally {
    await adminDb.rpc("advisory_unlock", { lock_key: lockKey }).catch(() => {});
  }
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

  // CONCURRENCY FIX (C-002): Advisory lock prevents concurrent streak-repair
  // double-spend. The lock key is derived from the student UUID hash so each
  // student gets their own lock, but concurrent repairs by the SAME student
  // are serialized.
  const lockKey = Math.abs(hashCode(user.id + ":streak_repair"));
  const { data: lockAcquired } = await adminDb.rpc("try_advisory_lock", {
    lock_key: lockKey,
  });

  if (!lockAcquired) {
    return err(c, "Otra operacion de reparacion esta en progreso. Intenta de nuevo.", 409);
  }

  try {
    const { data: xpData, error: xpErr } = await adminDb
      .from("student_xp")
      .select("total_xp")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .maybeSingle();

    if (xpErr) {
      return safeErr(c, "XP check", xpErr);
    }

    const totalXp = xpData?.total_xp ?? 0;
    if (totalXp < repairCost) {
      return err(
        c,
        `No tienes suficiente XP para reparar. Costo: ${repairCost} XP, tienes: ${totalXp} XP.`,
        400,
      );
    }

    // RPC-ONLY RULE NOTE:
    //   awardXP() / award_xp RPC reject xpBase <= 0, so they cannot be used
    //   for deductions. There is no dedicated `deduct_xp` RPC nor a
    //   `repair_streak` RPC analogous to `buy_streak_freeze`.
    //
    //   TODO: Create either a `deduct_xp` RPC or an atomic
    //   `repair_streak` RPC (modelled on `buy_streak_freeze`) that wraps
    //   the XP deduction + xp_transactions INSERT + student_stats UPDATE
    //   in a single transaction. Until then, we sequence the side-effects
    //   (streak restore, repair record, tx log) AFTER the XP mutation and
    //   roll back the deduction on streak-restore failure to keep this
    //   transactionally safe within JS.
    const { error: deductErr } = await adminDb
      .from("student_xp")
      .update({
        total_xp: totalXp - repairCost,
        updated_at: new Date().toISOString(),
      })
      .eq("student_id", user.id)
      .eq("institution_id", institutionId);

    if (deductErr) {
      return safeErr(c, "XP deduction", deductErr);
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

      return safeErr(c, "Streak restore", statsErr);
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
      console.error("[Streak Repair] Record insert failed:", repairErr.message);
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
  } finally {
    await adminDb.rpc("advisory_unlock", { lock_key: lockKey }).catch(() => {});
  }
});

// ─── Internal Helpers ────────────────────────────────────────

/**
 * Simple string hash to generate advisory lock keys.
 * Returns a 32-bit integer (safe for pg_try_advisory_lock).
 */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0; // Convert to 32-bit int
  }
  return hash;
}
