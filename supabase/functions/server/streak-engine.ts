/**
 * streak-engine.ts — Streak lifecycle management for Axon v4.4
 *
 * AUDIT FIXES:
 *   BUG-1 — Multi-day freeze: consumes N freezes for N missed days
 *   BUG-4 — streak_freezes_owned counter decremented on consume
 *   BUG-5 — streak XP filtering (events exported for caller)
 *   BUG-7 — Removed unreachable dead code branch
 *   A-014 — Freeze counter uses awaited atomic update (was fire-and-forget .then() chain)
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { getAdminClient } from "./db.ts";

// ─── Constants ───────────────────────────────────────────

const REPAIR_WINDOW_HOURS = 48;

// ─── Types ─────────────────────────────────────────────

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
  freezeUsedOnDates: string[];
}

// ─── Helpers ───────────────────────────────────────────

export function todayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

export function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

export function daysBetween(dateA: string | null, dateB: string): number | null {
  if (!dateA) return null;
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function nDaysBefore(dateStr: string, n: number): string[] {
  const dates: string[] = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().split("T")[0]);
  }
  return dates;
}

// ─── Compute Streak Status ─────────────────────────────

export async function computeStreakStatus(
  db: SupabaseClient,
  studentId: string,
  institutionId: string,
): Promise<StreakStatus> {
  const today = todayUTC();

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

  let repairEligible = false;
  if (currentStreak === 0 && lastStudyDate) {
    const lastStudyEnd = new Date(lastStudyDate + "T23:59:59Z");
    const hoursSince =
      (Date.now() - lastStudyEnd.getTime()) / (1000 * 60 * 60);
    repairEligible = hoursSince <= REPAIR_WINDOW_HOURS;
  }

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

  if (lastStudyDate === today) {
    events.push({
      type: "already_checked_in",
      message: "Ya registraste actividad hoy. Tu racha esta segura.",
    });
    return { newStreak, newLongest, events, freezeIdsToConsume, freezeUsedOnDates };
  }

  const daysMissed = daysBetween(lastStudyDate, today);

  if (lastStudyDate && daysMissed === 1) {
    newStreak = currentStreak + 1;
    if (newStreak > newLongest) newLongest = newStreak;
    events.push({
      type: "streak_incremented",
      message: `Racha de ${newStreak} dias! Sigue asi.`,
      data: { new_streak: newStreak },
    });
  } else if (lastStudyDate && daysMissed !== null && daysMissed >= 2) {
    const freezesNeeded = daysMissed - 1;
    const freezesAvailable = availableFreezeIds.length;

    if (freezesAvailable >= freezesNeeded) {
      const missedDates = nDaysBefore(today, freezesNeeded);
      for (let i = 0; i < freezesNeeded; i++) {
        freezeIdsToConsume.push(availableFreezeIds[i]);
        freezeUsedOnDates.push(missedDates[i]);
      }
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
      newStreak = 1;
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
  } else if (!lastStudyDate) {
    newStreak = 1;
    newLongest = Math.max(1, longestStreak);
    events.push({
      type: "streak_started",
      message: "Has comenzado tu primera racha de estudio!",
      data: { new_streak: 1 },
    });
  } else {
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

// ─── Daily Check-In ───────────────────────────────────

export async function performDailyCheckIn(
  studentId: string,
  institutionId: string,
): Promise<CheckInResult> {
  const db = getAdminClient();
  const today = todayUTC();

  const { data: stats } = await db
    .from("student_stats")
    .select("current_streak, longest_streak, last_study_date")
    .eq("student_id", studentId)
    .maybeSingle();

  const currentStreak = stats?.current_streak ?? 0;
  const longestStreak = stats?.longest_streak ?? 0;
  const lastStudyDate = stats?.last_study_date ?? null;

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

  const decision = _computeCheckInDecision(
    currentStreak,
    longestStreak,
    lastStudyDate,
    freezeIds,
    today,
  );

  // 4a: Consume freezes if needed
  if (decision.freezeIdsToConsume.length > 0) {
    const freezePromises = decision.freezeIdsToConsume.map((id, i) =>
      db
        .from("streak_freezes")
        .update({ used_on: decision.freezeUsedOnDates[i] })
        .eq("id", id)
    );
    await Promise.all(freezePromises);

    // A-014 FIX: Awaited atomic update instead of fire-and-forget .then() chain
    const consumed = decision.freezeIdsToConsume.length;
    // BH-ERR-016 FIX: Atomic decrement via RPC replaces race-prone SELECT→UPDATE
    try {
      const { error } = await db.rpc("decrement_streak_freezes", {
        p_student_id: studentId,
        p_institution_id: institutionId,
        p_amount: consumed,
      });
      if (error) throw error;

      console.warn(
        `[Streak Engine] Decremented streak_freezes_owned by ${consumed} for ${studentId}`,
      );
    } catch (e) {
      console.warn(
        "[Streak Engine] Failed to decrement streak_freezes_owned:",
        (e as Error).message,
      );
    }
  }

  // 4b: Update student_stats
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

  const status = await computeStreakStatus(
    db,
    studentId,
    institutionId,
  );
  return { streak_status: status, events: decision.events };
}
