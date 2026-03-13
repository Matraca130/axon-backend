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
 * AUDIT FIXES (PR #97):
 *   BUG-1 — Multi-day freeze: now consumes N freezes for N missed days
 *   BUG-4 — streak_freezes_owned counter now decremented on consume
 *   BUG-5 — streak XP filtering (events exported for caller inspection)
 *   BUG-7 — Removed unreachable dead code branch
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

// ─── Exported for testing — pure decision type ────────────

export interface CheckInDecision {
  newStreak: number;
  newLongest: number;
  events: CheckInEvent[];
  freezeIdsToConsume: string[];
  /** YYYY-MM-DD dates for each consumed freeze's used_on */
  freezeUsedOnDates: string[];
}

// ─── Helpers ───────────────────────────────────────────────

export function todayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

export function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

/**
 * Calculate days between two YYYY-MM-DD date strings.
 * Returns null if either date is null/invalid.
 */
export function daysBetween(dateA: string | null, dateB: string): number | null {
  if (!dateA) return null;
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Generate YYYY-MM-DD strings for N days before a given date.
 * Used to assign used_on dates to consumed freezes.
 * Example: nDaysBefore("2026-03-13", 2) → ["2026-03-12", "2026-03-11"]
 */
function nDaysBefore(dateStr: string, n: number): string[] {
  const dates: string[] = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().split("T")[0]);
  }
  return dates;
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

// ─── Pure Decision Logic (testable without DB) ─────────────

/**
 * Compute the check-in decision based on current state.
 * This is a PURE function — no DB calls, fully testable.
 *
 * @param currentStreak — Current streak value from student_stats
 * @param longestStreak — All-time longest streak
 * @param lastStudyDate — Last study date (YYYY-MM-DD) or null
 * @param availableFreezeIds — IDs of available (unused) streak freezes, oldest first
 * @param today — Today's date in YYYY-MM-DD (injectable for testing)
 * @returns CheckInDecision with new values and events
 */
export function _computeCheckInDecision(
  currentStreak: number,
  longestStreak: number,
  lastStudyDate: string | null,
  availableFreezeIds: string[],
  today: string,
): CheckInDecision {
  const events: CheckInEvent[] = [];
  let newStreak = currentStreak;
  let newLongest = longestStreak;
  const freezeIdsToConsume: string[] = [];
  const freezeUsedOnDates: string[] = [];

  // Case 1: Already studied today — idempotent return
  if (lastStudyDate === today) {
    events.push({
      type: "already_checked_in",
      message: "Ya registraste actividad hoy. Tu racha esta segura.",
    });
    return { newStreak, newLongest, events, freezeIdsToConsume, freezeUsedOnDates };
  }

  const daysMissed = daysBetween(lastStudyDate, today);

  // Case 2: Last study was yesterday → streak continues
  if (lastStudyDate && daysMissed === 1) {
    newStreak = currentStreak + 1;
    if (newStreak > newLongest) newLongest = newStreak;

    events.push({
      type: "streak_incremented",
      message: `Racha de ${newStreak} dias! Sigue asi.`,
      data: { new_streak: newStreak },
    });
  }
  // Case 3: Missed 2+ days
  else if (lastStudyDate && daysMissed !== null && daysMissed >= 2) {
    // Need (daysMissed - 1) freezes to cover each missed day
    // (today doesn't count as missed — student is here now)
    const freezesNeeded = daysMissed - 1;
    const freezesAvailable = availableFreezeIds.length;

    if (freezesAvailable >= freezesNeeded) {
      // Consume exactly freezesNeeded freezes (oldest first)
      const missedDates = nDaysBefore(today, freezesNeeded);

      for (let i = 0; i < freezesNeeded; i++) {
        freezeIdsToConsume.push(availableFreezeIds[i]);
        freezeUsedOnDates.push(missedDates[i]);
      }

      // Maintain streak + increment for today
      newStreak = currentStreak + 1;
      if (newStreak > newLongest) newLongest = newStreak;

      events.push({
        type: "freeze_consumed",
        message: freezesNeeded === 1
          ? `Se uso 1 streak freeze para proteger tu racha de ${currentStreak} dias.`
          : `Se usaron ${freezesNeeded} streak freezes para proteger tu racha de ${currentStreak} dias.`,
        data: {
          freezes_consumed: freezesNeeded,
          freezes_remaining: freezesAvailable - freezesNeeded,
          protected_streak: currentStreak,
          new_streak: newStreak,
          days_covered: missedDates,
        },
      });
    } else {
      // Not enough freezes → break streak
      newStreak = 1; // Today counts as day 1 of new streak

      events.push({
        type: "streak_broken",
        message: `Tu racha de ${currentStreak} dias se ha roto. Hoy empieza una nueva!`,
        data: {
          lost_streak: currentStreak,
          days_missed: daysMissed,
          freezes_available: freezesAvailable,
          freezes_needed: freezesNeeded,
        },
      });
    }
  }
  // Case 4: First time ever → start streak
  else if (!lastStudyDate) {
    newStreak = 1;
    newLongest = Math.max(1, longestStreak);

    events.push({
      type: "streak_started",
      message: "Has comenzado tu primera racha de estudio!",
      data: { new_streak: 1 },
    });
  }
  // Case 5: daysMissed is null (invalid date) → treat as first time
  else {
    newStreak = 1;
    newLongest = Math.max(1, longestStreak);

    events.push({
      type: "streak_started",
      message: "Has comenzado una nueva racha de estudio!",
      data: { new_streak: 1 },
    });
  }

  return { newStreak, newLongest, events, freezeIdsToConsume, freezeUsedOnDates };
}

// ─── Daily Check-In ───────────────────────────────────────

/**
 * Perform daily streak check-in.
 *
 * Called when student opens the app or starts a session.
 * Idempotent within the same day (safe to call multiple times).
 *
 * Logic (via _computeCheckInDecision):
 *   1. Already studied today? → return "already_checked_in"
 *   2. Last study was yesterday? → increment streak
 *   3. Last study was 2+ days ago? →
 *      a. Enough freezes? → consume N freezes, maintain streak
 *      b. Not enough? → break streak (set to 1)
 *   4. No last study (first time)? → start streak at 1
 *
 * BUG-1 FIX: Now correctly consumes (daysMissed - 1) freezes.
 *            Previously only consumed 1 regardless of gap size.
 * BUG-4 FIX: Now decrements streak_freezes_owned counter after
 *            consuming freezes (fire-and-forget).
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

  // Step 2: Fetch available freezes (oldest first) for decision logic
  const { data: availableFreezes } = await db
    .from("streak_freezes")
    .select("id")
    .eq("student_id", studentId)
    .eq("institution_id", institutionId)
    .is("used_on", null)
    .order("created_at", { ascending: true });

  const freezeIds = (availableFreezes ?? []).map(
    (f: { id: string }) => f.id,
  );

  // Step 3: Pure decision logic (testable)
  const decision = _computeCheckInDecision(
    currentStreak,
    longestStreak,
    lastStudyDate,
    freezeIds,
    today,
  );

  // Step 4: Execute DB side effects

  // 4a: Consume freezes if needed
  if (decision.freezeIdsToConsume.length > 0) {
    // Update each freeze with its corresponding used_on date
    const freezePromises = decision.freezeIdsToConsume.map((id, i) =>
      db
        .from("streak_freezes")
        .update({ used_on: decision.freezeUsedOnDates[i] })
        .eq("id", id)
    );
    await Promise.all(freezePromises);

    // BUG-4 FIX: Decrement streak_freezes_owned counter (fire-and-forget)
    const consumed = decision.freezeIdsToConsume.length;
    db.from("student_xp")
      .select("streak_freezes_owned")
      .eq("student_id", studentId)
      .eq("institution_id", institutionId)
      .single()
      .then(({ data: xp }: { data: { streak_freezes_owned?: number } | null }) => {
        if (xp) {
          const newCount = Math.max(0, (xp.streak_freezes_owned ?? 0) - consumed);
          db.from("student_xp")
            .update({ streak_freezes_owned: newCount })
            .eq("student_id", studentId)
            .eq("institution_id", institutionId)
            .then(() => {
              console.log(
                `[Streak Engine] Decremented streak_freezes_owned by ${consumed} for ${studentId}`,
              );
            });
        }
      })
      .catch((e: Error) => {
        console.warn(
          "[Streak Engine] Failed to decrement streak_freezes_owned:",
          e.message,
        );
      });
  }

  // 4b: Update student_stats (only if not "already_checked_in")
  const isAlreadyCheckedIn = decision.events.some(
    (e) => e.type === "already_checked_in",
  );

  if (!isAlreadyCheckedIn) {
    const { error: updateErr } = await db.from("student_stats").upsert(
      {
        student_id: studentId,
        current_streak: decision.newStreak,
        longest_streak: decision.newLongest,
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
  }

  // Return updated status
  const status = await computeStreakStatus(
    db,
    studentId,
    institutionId,
  );
  return { streak_status: status, events: decision.events };
}
