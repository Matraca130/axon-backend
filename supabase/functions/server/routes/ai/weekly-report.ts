/**
 * routes/ai/weekly-report.ts — Weekly classification report
 *
 * GET  /ai/weekly-report?institution_id=xxx          → latest report (or null)
 * GET  /ai/weekly-report?institution_id=xxx&history=true&limit=4
 * POST /ai/weekly-report  { institutionId }           → generate & persist
 *
 * Data collection is server-side via collectWeeklyData().
 * AI analysis via Claude (opus with haiku fallback).
 * Reports are idempotent per (student, institution, week_start).
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, getAdminClient, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import {
  generateText,
  parseClaudeJson,
  selectModelForTask,
} from "../../claude-ai.ts";
import {
  collectWeeklyData,
  getCurrentWeekStart,
  getCurrentWeekEnd,
  formatDate,
} from "../../lib/weekly-data-collector.ts";

export const aiWeeklyReportRoutes = new Hono();

// ─── GET /ai/weekly-report ───────────────────────────────

aiWeeklyReportRoutes.get(`${PREFIX}/ai/weekly-report`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id query parameter is required (UUID)");
  }

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status as 400 | 403);

  const history = c.req.query("history") === "true";
  const limit = Math.min(parseInt(c.req.query("limit") || "4", 10), 12);
  const weekStart = formatDate(getCurrentWeekStart());

  if (history) {
    // Return current + previous weeks
    const { data: reports, error } = await db
      .from("weekly_reports")
      .select("*")
      .eq("student_id", user.id)
      .eq("institution_id", institutionId)
      .order("week_start", { ascending: false })
      .limit(limit + 1); // +1 to include current week

    if (error) return safeErr(c, "fetch weekly reports", error);

    const all = reports || [];
    const current = all.find((r: { week_start: string }) => r.week_start === weekStart) || null;
    const previousWeeks = all.filter((r: { week_start: string }) => r.week_start !== weekStart).slice(0, limit);

    return ok(c, { current: current ? mapReport(current) : null, history: previousWeeks.map(mapReport) });
  }

  // Single latest report for current week
  const { data: report, error } = await db
    .from("weekly_reports")
    .select("*")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .eq("week_start", weekStart)
    .maybeSingle();

  if (error) return safeErr(c, "fetch weekly report", error);

  if (!report) {
    return ok(c, { data: null, hint: "generate" });
  }

  return ok(c, mapReport(report));
});

// ─── POST /ai/weekly-report ──────────────────────────────

aiWeeklyReportRoutes.post(`${PREFIX}/ai/weekly-report`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body");

  const institutionId = body.institutionId as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institutionId is required (UUID)");
  }

  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status as 400 | 403);

  const weekStart = formatDate(getCurrentWeekStart());
  const weekEnd = formatDate(getCurrentWeekEnd());

  // Idempotent: return existing report if already generated this week
  const { data: existing } = await db
    .from("weekly_reports")
    .select("*")
    .eq("student_id", user.id)
    .eq("institution_id", institutionId)
    .eq("week_start", weekStart)
    .maybeSingle();

  if (existing) {
    return ok(c, mapReport(existing));
  }

  // Collect all weekly data server-side
  const rawData = await collectWeeklyData(db, user.id, institutionId);

  // Generate AI analysis
  const startMs = Date.now();
  const model = selectModelForTask("weekly report"); // → opus

  const hours = Math.floor(rawData.totalTimeSeconds / 3600);
  const minutes = Math.floor((rawData.totalTimeSeconds % 3600) / 60);

  const prompt =
    `Datos de estudio semanal del alumno:\n` +
    `- Sesiones completadas: ${rawData.totalSessions}\n` +
    `- Reviews realizados: ${rawData.totalReviews}\n` +
    `- Precisión: ${rawData.accuracyPercent}%\n` +
    `- Tiempo total: ${hours}h ${minutes}min\n` +
    `- Días activos: ${rawData.daysActive}/7\n` +
    `- Racha actual: ${rawData.streakAtReport} días\n` +
    `- XP ganados: ${rawData.xpEarned}\n` +
    `- Temas débiles: ${JSON.stringify(rawData.weakTopics)}\n` +
    `- Temas fuertes: ${JSON.stringify(rawData.strongTopics)}\n` +
    `- Flashcards con lapses: ${JSON.stringify(rawData.lapsingCards)}\n\n` +
    `Responde EXCLUSIVAMENTE en JSON válido con este formato:\n` +
    `{\n` +
    `  "summary": "resumen motivacional de 2-3 oraciones en español",\n` +
    `  "strengths": ["fortaleza 1", "fortaleza 2"],\n` +
    `  "weaknesses": ["debilidad 1"],\n` +
    `  "masteryTrend": "improving|stable|declining",\n` +
    `  "recommendedFocus": [\n` +
    `    {"topicName": "...", "reason": "...", "suggestedMethod": "flashcard|quiz|read|review"}\n` +
    `  ]\n` +
    `}`;

  let aiResult: {
    summary: string;
    strengths: string[];
    weaknesses: string[];
    masteryTrend: string;
    recommendedFocus: { topicName: string; reason: string; suggestedMethod: string }[];
  };
  let tokensUsed = 0;
  let aiModel = "unknown";

  try {
    const res = await generateText({
      prompt,
      systemPrompt:
        "Eres un tutor médico experto. Analiza datos de estudio y genera reportes " +
        "semanales precisos y motivacionales en español. Responde solo en JSON válido.",
      model,
      temperature: 0.4,
      maxTokens: 1024,
      jsonMode: true,
    });

    aiResult = parseClaudeJson(res.text);
    tokensUsed = res.tokensUsed.input + res.tokensUsed.output;
    aiModel = model; // will be "opus" or "haiku" if fallback kicked in
  } catch (e) {
    console.error(`[WeeklyReport] AI generation failed: ${(e as Error).message}`);
    // Persist report without AI analysis rather than failing entirely
    aiResult = {
      summary: "No se pudo generar el análisis automático esta semana.",
      strengths: [],
      weaknesses: [],
      masteryTrend: "stable",
      recommendedFocus: [],
    };
  }

  const latencyMs = Date.now() - startMs;

  // Persist via admin client (bypasses RLS for INSERT)
  const adminDb = getAdminClient();
  const { data: inserted, error: insertErr } = await adminDb
    .from("weekly_reports")
    .insert({
      student_id: user.id,
      institution_id: institutionId,
      week_start: weekStart,
      week_end: weekEnd,
      total_sessions: rawData.totalSessions,
      total_reviews: rawData.totalReviews,
      correct_reviews: rawData.correctReviews,
      accuracy_percent: rawData.accuracyPercent,
      total_time_seconds: rawData.totalTimeSeconds,
      days_active: rawData.daysActive,
      streak_at_report: rawData.streakAtReport,
      xp_earned: rawData.xpEarned,
      weak_topics: rawData.weakTopics,
      strong_topics: rawData.strongTopics,
      lapsing_cards: rawData.lapsingCards,
      ai_summary: aiResult.summary,
      ai_strengths: aiResult.strengths,
      ai_weaknesses: aiResult.weaknesses,
      ai_mastery_trend: aiResult.masteryTrend,
      ai_recommended_focus: aiResult.recommendedFocus,
      ai_model: aiModel,
      ai_tokens_used: tokensUsed,
      ai_latency_ms: latencyMs,
    })
    .select("*")
    .single();

  if (insertErr) return safeErr(c, "save weekly report", insertErr);

  return ok(c, mapReport(inserted), 201);
});

// ─── Response Mapper ─────────────────────────────────────

// deno-lint-ignore no-explicit-any
function mapReport(row: any) {
  return {
    id: row.id,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    totalSessions: row.total_sessions,
    totalReviews: row.total_reviews,
    correctReviews: row.correct_reviews,
    accuracyPercent: Number(row.accuracy_percent),
    totalTimeSeconds: row.total_time_seconds,
    daysActive: row.days_active,
    streakAtReport: row.streak_at_report,
    xpEarned: row.xp_earned,
    weakTopics: row.weak_topics,
    strongTopics: row.strong_topics,
    lapsingCards: row.lapsing_cards,
    aiSummary: row.ai_summary,
    aiStrengths: row.ai_strengths,
    aiWeaknesses: row.ai_weaknesses,
    aiMasteryTrend: row.ai_mastery_trend,
    aiRecommendedFocus: row.ai_recommended_focus,
    aiModel: row.ai_model,
    createdAt: row.created_at,
  };
}
