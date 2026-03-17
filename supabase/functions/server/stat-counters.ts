/**
 * stat-counters.ts -- Fire-and-forget daily stat counter helpers
 *
 * Provides atomic increment/reset for student_stats counters:
 *   reviews_today        -- incremented per review, reset at midnight
 *   sessions_today       -- incremented per session complete, reset at midnight
 *   correct_streak       -- incremented on correct, reset on incorrect
 *   challenges_completed -- incremented when challenge is claimed (NEVER reset)
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
  "challenges_completed",
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

// --- Convenience wrappers (used by xp-hooks + challenges) ---

/**
 * Increment reviews_today and handle correct_streak.
 * Called from review hooks after XP award.
 */
export function incrementReviewCounter(
  studentId: string,
  isCorrect: boolean,
): void {
  (async () => {
    // reviews_today and correct_streak are independent counters — run in parallel
    const streakPromise = isCorrect
      ? incrementStat(studentId, "correct_streak", 1)
      : resetCorrectStreak(studentId);

    await Promise.all([
      incrementStat(studentId, "reviews_today", 1),
      streakPromise,
    ]);
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

/**
 * Increment challenges_completed.
 * Called from POST /challenges/claim after successful claim.
 * This counter is NEVER reset (lifetime total).
 */
export function incrementChallengesCompleted(studentId: string): void {
  incrementStat(studentId, "challenges_completed", 1).catch((e) =>
    console.warn("[Stat Counters] incrementChallengesCompleted:", (e as Error).message),
  );
}

// --- Fallback: read-then-write (non-atomic) ---
//
// IMPORTANT: Must mirror the RPC logic in increment_daily_stat().
// When incrementing reviews_today, also increment total_reviews.
// When incrementing sessions_today, also increment total_sessions.
//
// NOTE: The student_stats row must already exist (created at enrollment time).
// If the row is missing, the UPDATE will match zero rows and the counters
// will be silently lost. There is no upsert here by design — enrollment
// is the canonical place to INSERT the row.

async function _incrementFallback(
  db: ReturnType<typeof getAdminClient>,
  studentId: string,
  field: StatField,
  amount: number,
): Promise<void> {
  try {
    // Determine which fields to select and update.
    // Mirror RPC: reviews_today also bumps total_reviews,
    //             sessions_today also bumps total_sessions.
    const extraField: string | null =
      field === "reviews_today" ? "total_reviews" :
      field === "sessions_today" ? "total_sessions" :
      null;

    const selectFields = extraField ? `${field}, ${extraField}` : field;

    const { data } = await db
      .from("student_stats")
      .select(selectFields)
      .eq("student_id", studentId)
      .single();

    const current = (data?.[field] as number) ?? 0;
    const updatePayload: Record<string, number> = {
      [field]: current + amount,
    };

    if (extraField) {
      const currentExtra = (data?.[extraField] as number) ?? 0;
      updatePayload[extraField] = currentExtra + amount;
    }

    await db
      .from("student_stats")
      .update(updatePayload)
      .eq("student_id", studentId);
  } catch (e) {
    console.warn(
      `[Stat Counters] Fallback failed for ${field}:`,
      (e as Error).message,
    );
  }
}
