/**
 * xp-engine.ts — XP calculation engine for Axon v4.4 Gamification
 *
 * Calculates XP with scientific bonuses:
 *   - On-Time Review Bonus (+50%): FSRS due_at alignment (Cepeda 2006)
 *   - Flow Zone Bonus (+25%): BKT p_know 0.3-0.7 (Csikszentmihalyi 1990)
 *   - Variable Reward (10% chance 2x): Skinner VR schedule
 *   - Streak Multiplier (+50% at 7+ days): Duolingo model
 *
 * Called fire-and-forget from afterWrite hooks.
 * Uses award_xp() RPC for atomic XP grant, with JS fallback (arch-5).
 *
 * CONTRACT COMPLIANCE:
 *   §2.5 — Uses getAdminClient() singleton (NOT per-request)
 *   §3.8 — Daily cap 500 enforced in RPC
 *   §5.4 — institution_id resolved by caller (hooks)
 *   §7.14 — No XP for notes/annotations (overjustification)
 *   §10 — Multipliers SUM, don't multiply
 *
 * EXPORTS (PR #102):
 *   LEVEL_THRESHOLDS — Single source of truth for level XP boundaries
 *   calculateLevel   — XP to level conversion (also used by gamification helpers)
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────

export interface AwardXPParams {
  db: SupabaseClient;
  studentId: string;
  institutionId: string;
  action: string;
  xpBase: number;
  sourceType?: string;
  sourceId?: string;
  // Optional context for bonus calculation
  fsrsDueAt?: string | null; // For on-time bonus
  bktPKnow?: number | null; // For flow zone bonus
  currentStreak?: number; // For streak multiplier
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

// ─── XP Table (matches gamification plan) ─────────────────────
// ⚠ NO XP for notes/annotations — overjustification effect (§7.14)

export const XP_TABLE: Record<string, number> = {
  review_flashcard: 5, // Any flashcard review
  review_correct: 10, // Correct flashcard review (grade >= 3)
  quiz_answer: 5, // Quiz attempt
  quiz_correct: 15, // Correct quiz answer
  complete_session: 25, // Study session completed
  complete_reading: 30, // Summary marked as read
  complete_video: 20, // Video watched to completion
  streak_daily: 15, // Daily login streak reward
  complete_plan_task: 15, // Study plan task completed
  complete_plan: 100, // Full study plan completed
  rag_question: 5, // RAG AI question asked
};

// ─── Level Thresholds ─────────────────────────────────────────
// Single source of truth — used by xp-engine fallback AND
// gamification helpers (re-exported). Keep in sync with award_xp() RPC.

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

// ─── Core: Award XP ──────────────────────────────────────────

/**
 * Calculate bonuses and award XP via RPC (or JS fallback).
 *
 * Bonuses are ADDITIVE (§10 Combo rule):
 *   base=10, on_time+flow → multiplier = 1.0 + 0.5 + 0.25 = 1.75
 *   final = 10 * 1.75 = 17.5 → 18 XP
 *
 * Fire-and-forget safe: catches all errors, returns null on failure.
 */
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

  let multiplier = 1.0;
  let bonusType: string | null = null;

  // 1. On-Time Review Bonus (+50%) — Cepeda 2006
  //    Awarded when review happens within 24h of FSRS due_at
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
  //    BKT p_know between 0.3-0.7 = optimal challenge zone
  if (bktPKnow !== null && bktPKnow !== undefined) {
    if (bktPKnow >= 0.3 && bktPKnow <= 0.7) {
      multiplier += 0.25;
      bonusType = bonusType ? `${bonusType}+flow_zone` : "flow_zone";
    }
  }

  // 3. Variable Reward (10% chance 2x) — Skinner VR schedule
  //    ⚠ Multipliers SUM, not multiply (§10 Combo rule)
  if (Math.random() < 0.1) {
    multiplier += 1.0;
    bonusType = bonusType ? `${bonusType}+variable` : "variable";
  }

  // 4. Streak Multiplier (+50% at 7+ days) — Duolingo model
  if (currentStreak && currentStreak >= 7) {
    multiplier += 0.5;
    bonusType = bonusType ? `${bonusType}+streak` : "streak";
  }

  // ─── RPC path (primary) ─────────────────────────────────────
  try {
    const { data, error } = await db.rpc("award_xp", {
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
        db,
        studentId,
        institutionId,
        action,
        xpBase,
        multiplier,
        bonusType,
        sourceType,
        sourceId,
      );
    }

    console.log(
      `[XP Engine] Awarded ${(data as AwardResult).xp_awarded} XP to ${studentId} ` +
        `(action=${action}, bonus=${bonusType ?? "none"})`,
    );
    return data as AwardResult;
  } catch (e) {
    console.warn("[XP Engine] Exception:", (e as Error).message);
    return null;
  }
}

// ─── JS Fallback (arch-5) ─────────────────────────────────────
// Used when award_xp() RPC is unavailable. NOT atomic — race
// conditions possible but acceptable for fallback path.

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

    // Insert transaction log
    const { error: txError } = await db.from("xp_transactions").insert({
      student_id: studentId,
      institution_id: institutionId,
      action,
      xp_base: xpBase,
      xp_final: xpFinal,
      multiplier,
      bonus_type: bonusType,
      source_type: sourceType ?? null,
      source_id: sourceId ?? null,
    });

    if (txError) {
      console.warn(
        "[XP Engine] Fallback tx insert failed:",
        txError.message,
      );
      return null;
    }

    // Upsert student_xp aggregate
    const { data: existing } = await db
      .from("student_xp")
      .select("total_xp, xp_today, xp_this_week")
      .eq("student_id", studentId)
      .eq("institution_id", institutionId)
      .single();

    const newTotal = (existing?.total_xp ?? 0) + xpFinal;
    const newToday = (existing?.xp_today ?? 0) + xpFinal;
    const newWeek = (existing?.xp_this_week ?? 0) + xpFinal;
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
      console.warn(
        "[XP Engine] Fallback upsert failed:",
        upsertError.message,
      );
      return null;
    }

    console.log(
      `[XP Engine] Fallback: awarded ${xpFinal} XP to ${studentId}`,
    );
    return {
      xp_awarded: xpFinal,
      xp_base: xpBase,
      multiplier,
      bonus_type: bonusType,
      daily_used: newToday,
      daily_cap: 500,
      total_xp: newTotal,
      level: newLevel,
    };
  } catch (e) {
    console.warn("[XP Engine] Fallback exception:", (e as Error).message);
    return null;
  }
}
