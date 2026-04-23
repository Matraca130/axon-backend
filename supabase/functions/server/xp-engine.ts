/**
 * xp-engine.ts — XP calculation engine for Axon v4.4 Gamification
 *
 * AUDIT FIXES:
 *   G-005 — awardXP validates xpBase > 0 early return
 *   G-006 — Fallback path enforces daily cap 500
 *   A-009 — Fallback uses .maybeSingle() (was .single(), crashed for new students)
 *   A-010 — Fallback gives 10% post-cap (was 0%, now matches RPC behavior)
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { getAdminClient } from "./db.ts";

// --- Types ---

export interface AwardXPParams {
  db: SupabaseClient;
  studentId: string;
  institutionId: string;
  action: string;
  xpBase: number;
  sourceType?: string;
  sourceId?: string;
  fsrsDueAt?: string | null;
  bktPKnow?: number | null;
  currentStreak?: number;
}

export interface AwardResult {
  xp_awarded: number;
  xp_base: number;
  multiplier: number;
  bonus_type: string | null;
  daily_used: number;
  daily_cap: number;
  total_xp: number;
  level: number;
}

// --- XP Table ---
// No XP for notes/annotations — overjustification effect (§7.14)
//
// MIRROR of frontend src/app/types/gamification.ts XP_TABLE — keep in sync.
// Per-action XP values MUST match byte-for-byte with FE definition.
// Phase 2 will extract a shared package.

export const XP_TABLE: Record<string, number> = {
  review_flashcard: 5,
  review_correct: 10,
  quiz_answer: 5,
  quiz_correct: 15,
  complete_session: 25,
  complete_reading: 30,
  complete_video: 20,
  streak_daily: 15,
  complete_plan_task: 15,
  complete_plan: 100,
  rag_question: 5,
};

// Daily XP cap (§3.8)
const DAILY_CAP = 500;
// Post-cap rate (§6.4) — students still earn 10% after hitting cap
const POST_CAP_RATE = 0.1;

// --- Level Thresholds ---
//
// MIRROR of frontend src/app/types/gamification.ts LEVEL_THRESHOLDS — keep in sync.
// Shape differs (BE: [xp, level] tuples in descending order; FE: objects with
// `title` in ascending order). xp/level values MUST match byte-for-byte.
export const LEVEL_THRESHOLDS: [number, number][] = [
  [10000, 12],
  [7500, 11],
  [5500, 10],
  [4000, 9],
  [3000, 8],
  [2200, 7],
  [1500, 6],
  [1000, 5],
  [600, 4],
  [300, 3],
  [100, 2],
];

export function calculateLevel(totalXp: number): number {
  for (const [threshold, level] of LEVEL_THRESHOLDS) {
    if (totalXp >= threshold) return level;
  }
  return 1;
}

// --- Core: Award XP ---

export async function awardXP(
  params: AwardXPParams,
): Promise<AwardResult | null> {
  const {
    db,
    studentId,
    institutionId,
    action,
    xpBase,
    sourceType,
    sourceId,
    fsrsDueAt,
    bktPKnow,
    currentStreak,
  } = params;

  // G-005 FIX: Validate xpBase > 0
  if (!xpBase || xpBase <= 0) {
    console.warn(`[XP Engine] Invalid xpBase=${xpBase} for action=${action}, skipping`);
    return null;
  }

  let multiplier = 1.0;
  let bonusType: string | null = null;

  // 1. On-Time Review Bonus (+50%) — Cepeda 2006
  if (fsrsDueAt) {
    const dueDate = new Date(fsrsDueAt);
    const now = new Date();
    const hoursDiff =
      Math.abs(now.getTime() - dueDate.getTime()) / (1000 * 60 * 60);
    if (hoursDiff <= 24) {
      multiplier += 0.5;
      bonusType = "on_time";
    }
  }

  // 2. Flow Zone Bonus (+25%) — Csikszentmihalyi 1990
  if (bktPKnow !== null && bktPKnow !== undefined) {
    if (bktPKnow >= 0.3 && bktPKnow <= 0.7) {
      multiplier += 0.25;
      bonusType = bonusType ? `${bonusType}+flow_zone` : "flow_zone";
    }
  }

  // 3. Variable Reward (10% chance 2x) — Skinner VR schedule
  if (Math.random() < 0.1) {
    multiplier += 1.0;
    bonusType = bonusType ? `${bonusType}+variable` : "variable";
  }

  // 4. Streak Multiplier (+50% at 7+ days) — Duolingo model
  if (currentStreak && currentStreak >= 7) {
    multiplier += 0.5;
    bonusType = bonusType ? `${bonusType}+streak` : "streak";
  }

  // --- RPC path (primary) ---
  // SEC: Use service_role client — award_xp revoked from authenticated
  // to prevent students self-awarding XP via PostgREST.
  try {
    const { data, error } = await getAdminClient().rpc("award_xp", {
      p_student_id: studentId,
      p_institution_id: institutionId,
      p_action: action,
      p_xp_base: xpBase,
      p_multiplier: multiplier,
      p_bonus_type: bonusType,
      p_source_type: sourceType ?? null,
      p_source_id: sourceId ?? null,
    });

    if (error) {
      console.warn(
        "[XP Engine] award_xp RPC failed, falling back to JS:",
        error.message,
      );
      return await awardXPFallback(
        db, studentId, institutionId, action,
        xpBase, multiplier, bonusType, sourceType, sourceId,
      );
    }

    console.warn(
      `[XP Engine] Awarded ${(data as AwardResult).xp_awarded} XP to ${studentId} ` +
        `(action=${action}, bonus=${bonusType ?? "none"})`,
    );
    return data as AwardResult;
  } catch (e) {
    console.warn("[XP Engine] Exception:", (e as Error).message);
    return null;
  }
}

// --- JS Fallback (arch-5) ---
// A-009 FIX: Uses .maybeSingle() (was .single() which crashes for new students)
// A-010 FIX: 10% post-cap rate (was 0%, now matches RPC)

async function awardXPFallback(
  db: SupabaseClient,
  studentId: string,
  institutionId: string,
  action: string,
  xpBase: number,
  multiplier: number,
  bonusType: string | null,
  sourceType?: string,
  sourceId?: string,
): Promise<AwardResult | null> {
  try {
    const xpFinal = Math.round(xpBase * multiplier);

    // A-009 FIX: .maybeSingle() instead of .single()
    // .single() throws when no row exists (new students not yet onboarded)
    const { data: existing } = await db
      .from("student_xp")
      .select("total_xp, xp_today, xp_this_week")
      .eq("student_id", studentId)
      .eq("institution_id", institutionId)
      .maybeSingle();

    const currentDailyUsed = existing?.xp_today ?? 0;
    const remainingCap = DAILY_CAP - currentDailyUsed;

    let cappedXp: number;
    if (remainingCap <= 0) {
      // A-010 FIX: 10% post-cap rate (matches RPC §6.4)
      // Students still earn something to maintain engagement
      cappedXp = Math.max(1, Math.round(xpFinal * POST_CAP_RATE));
      console.warn(
        `[XP Engine] Fallback: daily cap reached for ${studentId}, awarding 10% (${cappedXp} XP)`,
      );
    } else {
      // Cap the award to remaining daily allowance
      cappedXp = Math.min(xpFinal, remainingCap);
    }

    // Insert transaction log
    const { error: txError } = await db.from("xp_transactions").insert({
      student_id: studentId,
      institution_id: institutionId,
      action,
      xp_base: xpBase,
      xp_final: cappedXp,
      multiplier,
      bonus_type: bonusType,
      source_type: sourceType ?? null,
      source_id: sourceId ?? null,
    });

    if (txError) {
      console.warn("[XP Engine] Fallback tx insert failed:", txError.message);
      return null;
    }

    // Upsert student_xp aggregate
    const newTotal = (existing?.total_xp ?? 0) + cappedXp;
    const newToday = currentDailyUsed + cappedXp;
    const newWeek = (existing?.xp_this_week ?? 0) + cappedXp;
    const newLevel = calculateLevel(newTotal);

    const { error: upsertError } = await db.from("student_xp").upsert(
      {
        student_id: studentId,
        institution_id: institutionId,
        total_xp: newTotal,
        xp_today: newToday,
        xp_this_week: newWeek,
        current_level: newLevel,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "student_id,institution_id" },
    );

    if (upsertError) {
      console.warn("[XP Engine] Fallback upsert failed:", upsertError.message);
      return null;
    }

    console.warn(
      `[XP Engine] Fallback: awarded ${cappedXp} XP to ${studentId} (daily: ${newToday}/${DAILY_CAP})`,
    );
    return {
      xp_awarded: cappedXp,
      xp_base: xpBase,
      multiplier,
      bonus_type: bonusType,
      daily_used: newToday,
      daily_cap: DAILY_CAP,
      total_xp: newTotal,
      level: newLevel,
    };
  } catch (e) {
    console.warn("[XP Engine] Fallback exception:", (e as Error).message);
    return null;
  }
}
