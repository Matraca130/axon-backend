/**
 * stat-counters.ts -- Fire-and-forget daily stat counter helpers
 *
 * Provides atomic increment/reset for student_stats daily counters:
 *   reviews_today   -- incremented per review, reset at midnight
 *   sessions_today  -- incremented per session complete, reset at midnight
 *   correct_streak  -- incremented on correct, reset on incorrect
 *
 * Uses increment_daily_stat() RPC for atomic updates.
 * Falls back to read-then-write if RPC unavailable.
 *
 * All functions are fire-and-forget safe (catch all errors).
 *
 * EXPORTS (for testing):
 *   VALID_STAT_FIELDS -- whitelisted field names
 *   isValidStatField  -- pure validation
 */

import { getAdminClient } from "./db.ts";

// --- Whitelisted fields (must match RPC) ---

export const VALID_STAT_FIELDS = [
  "reviews_today",
  "sessions_today",
  "correct_streak",
] as const;

export type StatField = typeof VALID_STAT_FIELDS[number];

export function isValidStatField(field: string): field is StatField {
  return VALID_STAT_FIELDS.includes(field as StatField);
}

// --- Core: Atomic increment via RPC ---

export async function incrementStat(
  studentId: string,
  field: StatField,
  amount: number = 1,
): Promise<void> {
  const db = getAdminClient();

  try {
    const { error } = await db.rpc("increment_daily_stat", {
      p_student_id: studentId,
      p_field: field,
      p_amount: amount,
    });

    if (error) {
      console.warn(
        `[Stat Counters] RPC failed for ${field}, falling back:`,
        error.message,
      );
      await _incrementFallback(db, studentId, field, amount);
    }
  } catch (e) {
    console.warn(
      `[Stat Counters] incrementStat error (${field}):`,
      (e as Error).message,
    );
  }
}

// --- Reset correct_streak (on incorrect answer) ---

export async function resetCorrectStreak(studentId: string): Promise<void> {
  const db = getAdminClient();

  try {
    const { error } = await db.rpc("reset_correct_streak", {
      p_student_id: studentId,
    });

    if (error) {
      // Fallback: direct update
      await db
        .from("student_stats")
        .update({ correct_streak: 0 })
        .eq("student_id", studentId);
    }
  } catch (e) {
    console.warn(
      "[Stat Counters] resetCorrectStreak error:",
      (e as Error).message,
    );
  }
}

// --- Convenience wrappers (used by xp-hooks) ---

/**
 * Increment reviews_today and handle correct_streak.
 * Called from review hooks after XP award.
 *
 * @param studentId -- student UUID
 * @param isCorrect -- whether the review was correct (grade >= 3)
 */
export function incrementReviewCounter(
  studentId: string,
  isCorrect: boolean,
): void {
  // Fire-and-forget: don't await
  (async () => {
    await incrementStat(studentId, "reviews_today", 1);

    if (isCorrect) {
      await incrementStat(studentId, "correct_streak", 1);
    } else {
      await resetCorrectStreak(studentId);
    }
  })().catch((e) =>
    console.warn("[Stat Counters] incrementReviewCounter:", (e as Error).message),
  );
}

/**
 * Increment sessions_today.
 * Called from session complete hook after XP award.
 */
export function incrementSessionCounter(studentId: string): void {
  incrementStat(studentId, "sessions_today", 1).catch((e) =>
    console.warn("[Stat Counters] incrementSessionCounter:", (e as Error).message),
  );
}

// --- Fallback: read-then-write (non-atomic) ---

async function _incrementFallback(
  db: ReturnType<typeof getAdminClient>,
  studentId: string,
  field: StatField,
  amount: number,
): Promise<void> {
  try {
    const { data } = await db
      .from("student_stats")
      .select(field)
      .eq("student_id", studentId)
      .single();

    const current = (data?.[field] as number) ?? 0;

    await db
      .from("student_stats")
      .update({ [field]: current + amount })
      .eq("student_id", studentId);
  } catch (e) {
    console.warn(
      `[Stat Counters] Fallback failed for ${field}:`,
      (e as Error).message,
    );
  }
}
