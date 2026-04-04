/**
 * routes/ai/weekly-report.ts — Weekly study report
 *
 * GET  /ai/weekly-report?institution_id=xxx           → latest report (current week)
 * GET  /ai/weekly-report?institution_id=xxx&history=true&limit=4 → historical reports
 * POST /ai/weekly-report  { institutionId }           → generate & persist new report
 *
 * Response shape:
 *   {
 *     id, weekStart, weekEnd,
 *     totalSessions, totalReviews, correctReviews,
 *     totalTimeSeconds, daysActive, streakAtReport, xpEarned,
 *     summary, strengths[], weaknesses[], recommendations[],
 *     aiModel, createdAt
 *   }
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, getAdminClient, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import {
  generateText,
  selectModelForTask,
} from "../../claude-ai.ts";

export const aiWeeklyReportRoutes = new Hono();

// ─── Helpers ────────────────────────────────────────────

function getWeekStart(date: Date = new Date()): string {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setUTCDate(diff);
  return d.toISOString().split("T")[0];
}

function getWeekEnd(weekStart: string): string {
  const d = new Date(weekStart);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().split("T")[0];
}

interface ReportRow {
  id: string;
  student_id: string;
  institution_id: string;
  week_start: string;
  week_end: string;
  total_sessions: number;
  total_reviews: number;
  correct_reviews: number;
  total_time_seconds: number;
  days_active: number;
  streak_at_report: number;
  xp_earned: number;
  ai_summary: string | null;
  ai_strengths: string[];
  ai_weaknesses: string[];
  ai_recommendations: string[];
  ai_model: string | null;
  created_at: string;
}

function mapReport(r: ReportRow) {
  return {
    id: r.id,
    weekStart: r.week_start,
    weekEnd: r.week_end,
    totalSessions: r.total_sessions,
    totalReviews: r.total_reviews,
    correctReviews: r.correct_reviews,
    totalTimeSeconds: r.total_time_seconds,
    daysActive: r.days_active,
    streakAtReport: r.streak_at_report,
    xpEarned: r.xp_earned,
    summary: r.ai_summary,
    strengths: r.ai_strengths,
    weaknesses: r.ai_weaknesses,
    recommendations: r.ai_recommendations,
    aiModel: r.ai_model,
    createdAt: r.created_at,
  };
}

// ─── GET /ai/weekly-report ──────────────────────────────

aiWeeklyReportRoutes.get(`${PREFIX}/ai/weekly-report`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id query param is required", 400);
  }

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status as 400 | 403);

  const history = c.req.query("history") === "true";

  if (history) {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "4", 10), 52);
    const { data, error } = await db
      .from("weekly_reports")
      .select("*")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .order("week_start", { ascending: false })
      .limit(limit);

    if (error) return err(c, "Failed to fetch reports", 500);
    return ok(c, (data ?? []).map(mapReport));
  }

  // Current week
  const weekStart = getWeekStart();
  const { data, error } = await db
    .from("weekly_reports")
    .select("*")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .eq("week_start", weekStart)
    .limit(1)
    .single();

  if (error && error.code !== "PGRST116") {
    return err(c, "Failed to fetch report", 500);
  }

  return ok(c, data ? mapReport(data) : null);
});

// ─── POST /ai/weekly-report ─────────────────────────────

aiWeeklyReportRoutes.post(`${PREFIX}/ai/weekly-report`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  const institutionId = body.institutionId as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institutionId is required", 400);
  }

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status as 400 | 403);

  const weekStart = getWeekStart();
  const weekEnd = getWeekEnd(weekStart);

  // Collect raw stats for the week
  // First fetch sessions to get IDs for defense-in-depth review filtering
  const [sessionsRes, xpRes, streakRes] = await Promise.all([
    db
      .from("study_sessions")
      .select("id, created_at", { count: "exact" })
      .eq("student_id", user.id)
      .gte("created_at", `${weekStart}T00:00:00Z`)
      .lte("created_at", `${weekEnd}T23:59:59Z`),
    db
      .from("xp_transactions")
      .select("amount")
      .eq("user_id", user.id)
      .gte("created_at", `${weekStart}T00:00:00Z`)
      .lte("created_at", `${weekEnd}T23:59:59Z`),
    db
      .from("student_xp")
      .select("current_streak")
      .eq("user_id", user.id)
      .limit(1)
      .single(),
  ]);

  // Defense-in-depth: filter reviews by user's own session IDs (alongside RLS)
  const sessionIds = (sessionsRes.data ?? []).map((s: { id: string }) => s.id);
  const reviewsRes = sessionIds.length > 0
    ? await db
        .from("reviews")
        .select("grade")
        .in("session_id", sessionIds)
        .gte("created_at", `${weekStart}T00:00:00Z`)
        .lte("created_at", `${weekEnd}T23:59:59Z`)
    : { data: [] };

  const totalSessions = sessionsRes.count ?? 0;
  const reviews = reviewsRes.data ?? [];
  const totalReviews = reviews.length;
  const correctReviews = reviews.filter((r: { grade: number }) => r.grade >= 3).length;
  const xpEarned = (xpRes.data ?? []).reduce(
    (sum: number, t: { amount: number }) => sum + (t.amount ?? 0),
    0,
  );
  const streakAtReport = streakRes.data?.current_streak ?? 0;

  // Count distinct active days
  const sessionDates = new Set(
    (sessionsRes.data ?? []).map((s: { created_at: string }) =>
      s.created_at.split("T")[0],
    ),
  );
  const daysActive = sessionDates.size;

  // Generate AI summary
  const model = selectModelForTask("weekly_report");
  const accuracy = totalReviews > 0 ? Math.round((correctReviews / totalReviews) * 100) : 0;

  let aiSummary = "";
  let aiStrengths: string[] = [];
  let aiWeaknesses: string[] = [];
  let aiRecommendations: string[] = [];
  let aiModel = "";

  try {
    const prompt = `Sos un tutor de estudio. Generá un breve reporte semanal en español rioplatense para un estudiante universitario de medicina.

Datos de la semana (${weekStart} a ${weekEnd}):
- Sesiones de estudio: ${totalSessions}
- Días activos: ${daysActive}/7
- Revisiones totales: ${totalReviews}
- Precisión: ${accuracy}%
- Racha actual: ${streakAtReport} días
- XP ganado: ${xpEarned}

Respondé en JSON exacto:
{
  "summary": "Resumen de 2-3 oraciones",
  "strengths": ["fortaleza 1", "fortaleza 2"],
  "weaknesses": ["debilidad 1"],
  "recommendations": ["recomendación 1", "recomendación 2"]
}`;

    const result = await generateText({
      prompt,
      model,
      maxTokens: 500,
      temperature: 0.3,
    });

    aiModel = model;
    try {
      const parsed = JSON.parse(result.text);
      aiSummary = parsed.summary ?? "";
      aiStrengths = parsed.strengths ?? [];
      aiWeaknesses = parsed.weaknesses ?? [];
      aiRecommendations = parsed.recommendations ?? [];
    } catch {
      // If JSON parsing fails, use raw text as summary
      aiSummary = result.text;
    }
  } catch (e) {
    console.error(`[WeeklyReport] AI generation failed: ${(e as Error).message}`);
    aiSummary = "No se pudo generar el análisis AI esta semana.";
  }

  // Upsert report (idempotent per student+institution+week)
  const adminDb = getAdminClient();
  const { data: report, error: upsertErr } = await adminDb
    .from("weekly_reports")
    .upsert(
      {
        student_id: user.id,
        institution_id: institutionId,
        week_start: weekStart,
        week_end: weekEnd,
        total_sessions: totalSessions,
        total_reviews: totalReviews,
        correct_reviews: correctReviews,
        total_time_seconds: 0,
        days_active: daysActive,
        streak_at_report: streakAtReport,
        xp_earned: xpEarned,
        ai_summary: aiSummary,
        ai_strengths: aiStrengths,
        ai_weaknesses: aiWeaknesses,
        ai_recommendations: aiRecommendations,
        ai_model: aiModel,
      },
      { onConflict: "student_id,institution_id,week_start" },
    )
    .select()
    .single();

  if (upsertErr) {
    return err(c, "Failed to save report", 500);
  }

  return ok(c, mapReport(report), 201);
});
