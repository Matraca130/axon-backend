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
    | "streak_continued"
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
 *      a. Freeze available? → consume freeze, maintain streak
 *      b. No freeze? → break streak (set to 0)
 *   4. No last study (first time)? → start streak at 1
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
  // Case 3: Missed days
  else if (lastStudyDate) {
    const daysMissed = daysBetween(lastStudyDate, today);

    if (daysMissed !== null && daysMissed >= 2) {
      // Check for available freeze
      const { data: freeze } = await db
        .from("streak_freezes")
        .select("id")
        .eq("student_id", studentId)
        .eq("institution_id", institutionId)
        .is("used_on", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (freeze) {
        // Consume the freeze (oldest first)
        await db
          .from("streak_freezes")
          .update({ used_on: yesterday })
          .eq("id", freeze.id);

        // Maintain streak + increment for today
        newStreak = currentStreak + 1;
        if (newStreak > newLongest) newLongest = newStreak;

        events.push({
          type: "freeze_consumed",
          message: `Se uso un streak freeze para proteger tu racha de ${currentStreak} dias.`,
          data: {
            freeze_id: freeze.id,
            protected_streak: currentStreak,
            new_streak: newStreak,
          },
        });
      } else {
        // No freeze → break streak
        newStreak = 1; // Today counts as day 1 of new streak

        events.push({
          type: "streak_broken",
          message: `Tu racha de ${currentStreak} dias se ha roto. Hoy empieza una nueva!`,
          data: {
            lost_streak: currentStreak,
            days_missed: daysMissed,
          },
        });
      }
    } else {
      // daysMissed === 1 means yesterday, already handled above
      // daysMissed === 0 means today, handled in Case 1
      newStreak = currentStreak + 1;
      if (newStreak > newLongest) newLongest = newStreak;
    }
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
