/**
 * streak-engine.ts — Streak lifecycle management for Axon v4.4
 *
 * Extracted from routes-gamification.tsx for reuse by:
 *   - GET /gamification/streak-status
 *   - POST /gamification/daily-check-in
 *   - Potential future cron job for daily streak processing
 *
 * Streak lifecycle:
 *   1. Student studies → streak increments
 *   2. Student misses a day → check for freeze → consume or break
 *   3. Student repairs broken streak → restores previous value
 *
 * Date handling:
 *   All streak logic uses UTC date-only (YYYY-MM-DD) to avoid
 *   timezone confusion. The student's "today" is determined
 *   server-side in UTC. This matches the daily_activities table
 *   which also uses activity_date in YYYY-MM-DD format.
 *
 * CONTRACT COMPLIANCE:
 *   §2.5 — Uses getAdminClient() singleton for cross-table ops
 *   §7.9 — student_stats updates are direct (not XP table)
 *
 * AUDIT FIX LOG (PR #97):
 *   BUG-1: Multi-day freeze now requires 1 freeze per missed day
 *   BUG-4: streak_freezes_owned decremented on freeze consumption
 *   BUG-6: Removed unused 'streak_continued' from event type union
 *   BUG-7: Removed dead code branch (daysMissed < 2 unreachable)
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { getAdminClient } from "./db.ts";

// ─── Constants ───────────────────────────────────────────────

const REPAIR_WINDOW_HOURS = 48;

// ─── Types ─────────────────────────────────────────────────

export interface StreakStatus {
  current_streak: number;
  longest_streak: number;
  last_study_date: string | null;
  freezes_available: number;
  repair_eligible: boolean;
  streak_at_risk: boolean;
  studied_today: boolean;
  days_since_last_study: number | null;
}

export interface CheckInResult {
  streak_status: StreakStatus;
  events: CheckInEvent[];
}

export interface CheckInEvent {
  type:
    | "streak_started"
    | "streak_incremented"
    | "freeze_consumed"
    | "streak_broken"
    | "already_checked_in";
  message: string;
  data?: Record<string, unknown>;
}

// ─── Helpers ───────────────────────────────────────────────

function todayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

/**
 * Calculate days between two YYYY-MM-DD date strings.
 * Returns null if either date is null/invalid.
 */
function daysBetween(dateA: string | null, dateB: string): number | null {
  if (!dateA) return null;
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Compute Streak Status ─────────────────────────────────

/**
 * Compute detailed streak status from student data.
 * Does NOT modify any data — pure read operation.
 *
 * @param db — User-scoped Supabase client
 * @param studentId — The student's UUID
 * @param institutionId — For freeze count lookup
 */
export async function computeStreakStatus(
  db: SupabaseClient,
  studentId: string,
  institutionId: string,
): Promise<StreakStatus> {
  const today = todayUTC();

  // Parallel fetch: stats + active freezes
  const [statsResult, freezeResult] = await Promise.all([
    db
      .from("student_stats")
      .select("current_streak, longest_streak, last_study_date")
      .eq("student_id", studentId)
      .maybeSingle(),
    db
      .from("streak_freezes")
      .select("id", { count: "exact", head: true })
      .eq("student_id", studentId)
      .eq("institution_id", institutionId)
      .is("used_on", null),
  ]);

  const stats = statsResult.data;
  const currentStreak = stats?.current_streak ?? 0;
  const longestStreak = stats?.longest_streak ?? 0;
  const lastStudyDate = stats?.last_study_date ?? null;
  const freezesAvailable = freezeResult.count ?? 0;

  const daysSinceLast = daysBetween(lastStudyDate, today);
  const studiedToday = lastStudyDate === today;

  // Repair eligible: streak broken (= 0) AND break within 48h
  let repairEligible = false;
  if (currentStreak === 0 && lastStudyDate) {
    const lastStudyEnd = new Date(lastStudyDate + "T23:59:59Z");
    const hoursSince =
      (Date.now() - lastStudyEnd.getTime()) / (1000 * 60 * 60);
    repairEligible = hoursSince <= REPAIR_WINDOW_HOURS;
  }

  // Streak at risk: studied yesterday but NOT today, no freeze
  const streakAtRisk =
    currentStreak > 0 &&
    !studiedToday &&
    daysSinceLast === 1 &&
    freezesAvailable === 0;

  return {
    current_streak: currentStreak,
    longest_streak: longestStreak,
    last_study_date: lastStudyDate,
    freezes_available: freezesAvailable,
    repair_eligible: repairEligible,
    streak_at_risk: streakAtRisk,
    studied_today: studiedToday,
    days_since_last_study: daysSinceLast,
  };
}

// ─── Daily Check-In ───────────────────────────────────────

/**
 * Perform daily streak check-in.
 *
 * Called when student opens the app or starts a session.
 * Idempotent within the same day (safe to call multiple times).
 *
 * Logic:
 *   1. Already studied today? → return "already_checked_in"
 *   2. Last study was yesterday? → increment streak, return "streak_incremented"
 *   3. Last study was 2+ days ago? →
 *      a. Enough freezes for all missed days? → consume freezes, maintain streak
 *      b. Not enough freezes? → break streak (set to 1, today = day 1)
 *   4. No last study (first time)? → start streak at 1
 *
 * BUG-1 FIX: Each missed day requires 1 freeze. If a student missed 3 days
 * and only has 2 freezes, the streak breaks. Previously only 1 freeze was
 * consumed regardless of gap size.
 *
 * @param studentId — The student's UUID
 * @param institutionId — For freeze operations
 * @returns CheckInResult with updated status + events
 */
export async function performDailyCheckIn(
  studentId: string,
  institutionId: string,
): Promise<CheckInResult> {
  const db = getAdminClient();
  const today = todayUTC();
  const yesterday = yesterdayUTC();
  const events: CheckInEvent[] = [];

  // Step 1: Get current stats
  const { data: stats } = await db
    .from("student_stats")
    .select("current_streak, longest_streak, last_study_date")
    .eq("student_id", studentId)
    .maybeSingle();

  const currentStreak = stats?.current_streak ?? 0;
  const longestStreak = stats?.longest_streak ?? 0;
  const lastStudyDate = stats?.last_study_date ?? null;

  // Case 1: Already studied today — idempotent return
  if (lastStudyDate === today) {
    events.push({
      type: "already_checked_in",
      message: "Ya registraste actividad hoy. Tu racha esta segura.",
    });

    const status = await computeStreakStatus(
      db,
      studentId,
      institutionId,
    );
    return { streak_status: status, events };
  }

  let newStreak = currentStreak;
  let newLongest = longestStreak;

  // Case 2: Last study was yesterday → streak continues
  if (lastStudyDate === yesterday) {
    newStreak = currentStreak + 1;
    if (newStreak > newLongest) newLongest = newStreak;

    events.push({
      type: "streak_incremented",
      message: `Racha de ${newStreak} dias! Sigue asi.`,
      data: { new_streak: newStreak },
    });
  }
  // Case 3: Missed days (last study was 2+ days ago)
  else if (lastStudyDate) {
    const daysMissed = daysBetween(lastStudyDate, today);

    if (daysMissed !== null && daysMissed >= 2) {
      // BUG-1 FIX: Need 1 freeze per missed day (gap - 1 since today they're back)
      // Example: last study 3 days ago → daysMissed = 3 → freezesNeeded = 2
      const freezesNeeded = daysMissed - 1;

      // Count available freezes
      const { data: availableFreezes } = await db
        .from("streak_freezes")
        .select("id")
        .eq("student_id", studentId)
        .eq("institution_id", institutionId)
        .is("used_on", null)
        .order("created_at", { ascending: true })
        .limit(freezesNeeded);

      const freezeCount = availableFreezes?.length ?? 0;

      if (freezeCount >= freezesNeeded) {
        // Enough freezes — consume all needed, maintain streak
        const freezeIds = availableFreezes!.map(
          (f: { id: string }) => f.id,
        );

        // Consume freezes: assign each to a missed day
        for (let i = 0; i < freezesNeeded; i++) {
          const missedDate = new Date(today + "T00:00:00Z");
          missedDate.setUTCDate(
            missedDate.getUTCDate() - (freezesNeeded - i),
          );
          const missedDateStr = missedDate.toISOString().split("T")[0];

          await db
            .from("streak_freezes")
            .update({ used_on: missedDateStr })
            .eq("id", freezeIds[i]);
        }

        // Maintain streak + increment for today
        newStreak = currentStreak + 1;
        if (newStreak > newLongest) newLongest = newStreak;

        events.push({
          type: "freeze_consumed",
          message:
            freezesNeeded === 1
              ? `Se uso 1 streak freeze para proteger tu racha de ${currentStreak} dias.`
              : `Se usaron ${freezesNeeded} streak freezes para proteger tu racha de ${currentStreak} dias.`,
          data: {
            freezes_used: freezesNeeded,
            freeze_ids: freezeIds,
            protected_streak: currentStreak,
            new_streak: newStreak,
          },
        });

        // BUG-4 FIX: Decrement streak_freezes_owned counter (fire-and-forget)
        db.from("student_xp")
          .select("streak_freezes_owned")
          .eq("student_id", studentId)
          .eq("institution_id", institutionId)
          .single()
          .then(({ data: xp }) => {
            if (xp) {
              const newOwned = Math.max(
                0,
                (xp.streak_freezes_owned ?? 0) - freezesNeeded,
              );
              db.from("student_xp")
                .update({ streak_freezes_owned: newOwned })
                .eq("student_id", studentId)
                .eq("institution_id", institutionId)
                .then(() => {})
                .catch((e: Error) =>
                  console.warn(
                    "[Streak Engine] Failed to decrement freezes_owned:",
                    e.message,
                  ),
                );
            }
          })
          .catch(() => {}); // fire-and-forget, don't block check-in
      } else {
        // Not enough freezes → break streak
        newStreak = 1; // Today counts as day 1 of new streak

        events.push({
          type: "streak_broken",
          message: `Tu racha de ${currentStreak} dias se ha roto. Hoy empieza una nueva!`,
          data: {
            lost_streak: currentStreak,
            days_missed: daysMissed,
            freezes_available: freezeCount,
            freezes_needed: freezesNeeded,
          },
        });
      }
    }
    // daysMissed === 1 is handled by Case 2 (lastStudyDate === yesterday)
    // daysMissed === 0 is handled by Case 1 (lastStudyDate === today)
    // Both are already covered above, so no else branch needed.
  }
  // Case 4: First time ever → start streak
  else {
    newStreak = 1;
    newLongest = Math.max(1, longestStreak);

    events.push({
      type: "streak_started",
      message: "Has comenzado tu primera racha de estudio!",
      data: { new_streak: 1 },
    });
  }

  // Update student_stats
  const { error: updateErr } = await db.from("student_stats").upsert(
    {
      student_id: studentId,
      current_streak: newStreak,
      longest_streak: newLongest,
      last_study_date: today,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "student_id" },
  );

  if (updateErr) {
    console.error(
      "[Streak Engine] Failed to update student_stats:",
      updateErr.message,
    );
  }

  // Return updated status
  const status = await computeStreakStatus(
    db,
    studentId,
    institutionId,
  );
  return { streak_status: status, events };
}
