/**
 * lib/weekly-data-collector.ts — Shared weekly data collection
 *
 * Centralizes the 5 queries needed for a weekly student report.
 * Used by:
 *   - POST /ai/weekly-report (endpoint, with institutionId)
 *   - WhatsApp executeWeeklyReport (bot, without institutionId)
 *   - Telegram executeWeeklyReport (bot, without institutionId)
 *
 * institutionId is optional: when omitted, knowledge context
 * (weak/strong/lapsing) and XP are skipped — backwards-compatible
 * with bot payloads that don't carry institution info.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { getAdminClient } from "../db.ts";

// ─── Types ───────────────────────────────────────────────

export interface WeeklyWeakTopic {
  topicName: string;
  masteryLevel: number;
  reason: string;
}

export interface WeeklyStrongTopic {
  topicName: string;
  masteryLevel: number;
}

export interface WeeklyLapsingCard {
  cardFront: string;
  keyword: string;
  lapses: number;
}

export interface WeeklyRawData {
  totalSessions: number;
  totalReviews: number;
  correctReviews: number;
  accuracyPercent: number;
  totalTimeSeconds: number;
  daysActive: number;
  streakAtReport: number;
  xpEarned: number;
  weakTopics: WeeklyWeakTopic[];
  strongTopics: WeeklyStrongTopic[];
  lapsingCards: WeeklyLapsingCard[];
}

// ─── Helpers ─────────────────────────────────────────────

/** Monday of the current week (UTC). */
export function getCurrentWeekStart(): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  const monday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - diff,
  ));
  return monday;
}

/** Sunday of the current week (UTC). */
export function getCurrentWeekEnd(): Date {
  const monday = getCurrentWeekStart();
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return sunday;
}

/** Format Date as YYYY-MM-DD. */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── RPC Response Mapping ────────────────────────────────

interface KnowledgeProfile {
  weak?: { sub: string; kw: string; p: number; att: number }[];
  strong?: { sub: string; kw: string; p: number }[];
  lapsing?: { card: string; kw: string; lapses: number; state: number }[];
}

function mapKnowledgeProfile(profile: KnowledgeProfile | null): {
  weakTopics: WeeklyWeakTopic[];
  strongTopics: WeeklyStrongTopic[];
  lapsingCards: WeeklyLapsingCard[];
} {
  if (!profile) {
    return { weakTopics: [], strongTopics: [], lapsingCards: [] };
  }

  const weakTopics: WeeklyWeakTopic[] = (profile.weak || []).map((w) => ({
    topicName: w.sub,
    masteryLevel: w.p,
    reason: `p_know ${w.p}, ${w.att} intentos – keyword: ${w.kw}`,
  }));

  const strongTopics: WeeklyStrongTopic[] = (profile.strong || []).map((s) => ({
    topicName: s.sub,
    masteryLevel: s.p,
  }));

  const lapsingCards: WeeklyLapsingCard[] = (profile.lapsing || []).map((l) => ({
    cardFront: l.card,
    keyword: l.kw,
    lapses: l.lapses,
  }));

  return { weakTopics, strongTopics, lapsingCards };
}

// ─── Main Collector ──────────────────────────────────────

/**
 * Collects all weekly study data for a student.
 *
 * @param db - Supabase client (user-scoped or admin)
 * @param studentId - The student's auth.users id
 * @param institutionId - Optional; when present, fetches knowledge
 *   context via RPC and XP data
 */
export async function collectWeeklyData(
  db: SupabaseClient,
  studentId: string,
  institutionId?: string,
): Promise<WeeklyRawData> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Build parallel queries — always run sessions, activities, stats
  const queries: Promise<unknown>[] = [
    // Q1: study_sessions (last 7 days)
    db.from("study_sessions")
      .select("id, total_reviews, correct_reviews")
      .eq("student_id", studentId)
      .gte("created_at", weekAgo),

    // Q2: daily_activities (last 7 days) — count distinct days + sum time
    db.from("daily_activities")
      .select("*")
      .eq("student_id", studentId)
      .gte("activity_date", weekAgo.slice(0, 10)),

    // Q3: student_stats — current streak
    db.from("student_stats")
      .select("current_streak")
      .eq("student_id", studentId)
      .maybeSingle(),
  ];

  // Q4: Knowledge context (requires institutionId)
  if (institutionId) {
    const adminDb = getAdminClient();
    queries.push(
      adminDb.rpc("get_student_knowledge_context", {
        p_student_id: studentId,
        p_institution_id: institutionId,
      }),
    );
  } else {
    queries.push(Promise.resolve({ data: null }));
  }

  // Q5: XP (requires institutionId)
  if (institutionId) {
    queries.push(
      db.from("student_xp")
        .select("xp_this_week")
        .eq("student_id", studentId)
        .eq("institution_id", institutionId)
        .maybeSingle(),
    );
  } else {
    queries.push(Promise.resolve({ data: null }));
  }

  const [sessionsRes, activitiesRes, statsRes, profileRes, xpRes] =
    await Promise.all(queries) as [
      // deno-lint-ignore no-explicit-any
      any, any, any, any, any,
    ];

  // ── Parse sessions ──
  const sessions = sessionsRes.data || [];
  const totalSessions = sessions.length;
  const totalReviews = sessions.reduce(
    (sum: number, s: { total_reviews?: number }) => sum + (s.total_reviews || 0),
    0,
  );
  const correctReviews = sessions.reduce(
    (sum: number, s: { correct_reviews?: number }) => sum + (s.correct_reviews || 0),
    0,
  );
  const accuracyPercent = totalReviews > 0
    ? Math.round((correctReviews / totalReviews) * 10000) / 100
    : 0;

  // ── Parse daily activities ──
  const activities = activitiesRes.data || [];
  const daysActive = Math.min(activities.length, 7);
  const totalTimeSeconds = activities.reduce(
    (sum: number, a: { total_time_seconds?: number }) =>
      sum + (a.total_time_seconds || 0),
    0,
  );

  // ── Parse streak ──
  const streakAtReport = statsRes.data?.current_streak ?? 0;

  // ── Parse knowledge context ──
  const { weakTopics, strongTopics, lapsingCards } = mapKnowledgeProfile(
    profileRes.data as KnowledgeProfile | null,
  );

  // ── Parse XP ──
  const xpEarned = xpRes.data?.xp_this_week ?? 0;

  return {
    totalSessions,
    totalReviews,
    correctReviews,
    accuracyPercent,
    totalTimeSeconds,
    daysActive,
    streakAtReport,
    xpEarned,
    weakTopics,
    strongTopics,
    lapsingCards,
  };
}
