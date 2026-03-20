/**
 * routes/ai/schedule-agent.ts — Claude-powered study schedule agent
 *
 * POST /ai/schedule-agent
 *   action: "distribute" | "recommend-today" | "reschedule" | "weekly-insight"
 *   studentProfile: object (mastery data, weeklyHours, history)
 *   planContext?: object (tasks, deadlines)
 *   completedTaskId?: string (for reschedule action)
 *   model?: ClaudeModel (default: sonnet)
 *
 * Uses Claude to generate personalized study schedules for medical students.
 * Logs every invocation to ai_schedule_logs for analytics.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, getAdminClient, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { generateText, parseClaudeJson, getModelId, type ClaudeModel } from "../../claude-ai.ts";

export const aiScheduleAgentRoutes = new Hono();

// Dedicated rate limit: 10 requests per hour for schedule agent
const SCHEDULE_RATE_LIMIT = 10;
const SCHEDULE_RATE_WINDOW_MS = 3600000;

const VALID_ACTIONS = ["distribute", "recommend-today", "reschedule", "weekly-insight"] as const;
type ScheduleAction = typeof VALID_ACTIONS[number];

const SYSTEM_PROMPT = `Eres un tutor medico experto en optimizacion de estudio y repeticion espaciada. Analizas el perfil de un estudiante de medicina y generas planes de estudio personalizados.

REGLAS:
1. Prioriza temas con bajo dominio (masteryPercent < 40) con mas tiempo y frecuencia
2. Alterna metodos de estudio (no 3 flashcards seguidas)
3. Fatiga cognitiva: temas dificiles temprano, ligeros al final de semana
4. Respeta weeklyHours del alumno
5. Temas needsReview=true van primero
6. Estima tiempos del historial del alumno, no promedios generales

RESPONDE EXCLUSIVAMENTE en JSON valido sin markdown.`;

function buildUserMessage(
  action: ScheduleAction,
  studentProfile: Record<string, unknown>,
  planContext?: Record<string, unknown>,
  completedTaskId?: string,
): string {
  const profileStr = JSON.stringify(studentProfile);

  switch (action) {
    case "distribute":
      return `Distribuye estas tareas de estudio de forma optima para este alumno.

Plan y tareas pendientes:
${JSON.stringify(planContext ?? {})}

Perfil del alumno:
${profileStr}

Responde con JSON: { "schedule": [ { "day": "lunes", "blocks": [ { "startTime": "08:00", "duration_min": 30, "taskType": "flashcard"|"quiz"|"read"|"review", "topicId": "...", "topicName": "...", "reason": "..." } ] } ], "totalHours": number, "tips": ["..."] }`;

    case "recommend-today":
      return `Recomienda que estudiar hoy para este alumno de medicina.

Perfil del alumno:
${profileStr}

Responde con JSON: { "recommendations": [ { "priority": 1, "taskType": "flashcard"|"quiz"|"read"|"review", "topicId": "...", "topicName": "...", "estimatedMinutes": number, "reason": "..." } ], "totalMinutes": number, "motivationalNote": "..." }`;

    case "reschedule":
      return `El alumno completo la tarea "${completedTaskId || "desconocida"}". Redistribuye las tareas pendientes considerando este progreso.

Tareas y plan actual:
${JSON.stringify(planContext ?? {})}

Perfil del alumno:
${profileStr}

Responde con JSON: { "updatedSchedule": [ { "day": "...", "blocks": [ { "startTime": "...", "duration_min": number, "taskType": "...", "topicId": "...", "topicName": "...", "reason": "..." } ] } ], "adjustmentReason": "...", "nextPriority": "..." }`;

    case "weekly-insight":
      return `Genera un analisis semanal del progreso de este alumno de medicina.

Perfil del alumno:
${profileStr}

Responde con JSON: { "weekSummary": "...", "strengths": ["..."], "weaknesses": ["..."], "masteryTrend": "improving"|"stable"|"declining", "recommendedFocus": [ { "topicName": "...", "reason": "...", "suggestedMethod": "..." } ], "estimatedWeeklyProgress": number }`;
  }
}

aiScheduleAgentRoutes.post(`${PREFIX}/ai/schedule-agent`, async (c: Context) => {
  const startMs = Date.now();

  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // -- Rate limit: 10 requests/hour for schedule agent
  {
    const adminDb = getAdminClient();
    const { data: rl, error: rlErr } = await adminDb.rpc("check_rate_limit", {
      p_key: `schedule-agent:${user.id}`,
      p_max_requests: SCHEDULE_RATE_LIMIT,
      p_window_ms: SCHEDULE_RATE_WINDOW_MS,
    });
    if (rlErr) {
      console.error(`[Schedule Agent] Rate limit RPC failed: ${rlErr.message}`);
      return err(c, "Could not verify rate limit status. Please try again later.", 500);
    }
    if (rl && !rl.allowed) {
      return err(
        c,
        `Schedule agent rate limit exceeded: max ${SCHEDULE_RATE_LIMIT} requests per hour. ` +
        `Try again in ${Math.ceil((rl.retry_after_ms || 0) / 1000)}s.`,
        429,
      );
    }
  }

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  // -- Validate action
  const action = body.action as string;
  if (!VALID_ACTIONS.includes(action as ScheduleAction)) {
    return err(
      c,
      `action must be one of: ${VALID_ACTIONS.join(", ")}`,
      400,
    );
  }

  // -- Validate studentProfile
  const studentProfile = body.studentProfile as Record<string, unknown> | undefined;
  if (!studentProfile || typeof studentProfile !== "object") {
    return err(c, "studentProfile is required (object)", 400);
  }

  const planContext = body.planContext as Record<string, unknown> | undefined;
  const completedTaskId = typeof body.completedTaskId === "string"
    ? body.completedTaskId
    : undefined;
  // -- Resolve institution for RBAC
  const institutionId = typeof body.institutionId === "string"
    ? body.institutionId
    : (studentProfile.institutionId as string | undefined);

  if (institutionId) {
    const roleCheck = await requireInstitutionRole(
      db, user.id, institutionId, ALL_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }
  }

  // -- Resolve model: explicit body.model > institution setting > default 'sonnet'
  let model: ClaudeModel = "sonnet";
  if (body.model === "opus" || body.model === "sonnet" || body.model === "haiku") {
    model = body.model;
  } else if (institutionId) {
    const { data: inst } = await db
      .from("institutions")
      .select("ai_model")
      .eq("id", institutionId)
      .single();
    if (inst?.ai_model === "opus" || inst?.ai_model === "sonnet") {
      model = inst.ai_model;
    }
  }

  // -- Build prompt and call Claude
  const userMessage = buildUserMessage(
    action as ScheduleAction,
    studentProfile,
    planContext,
    completedTaskId,
  );

  let tokensUsed = 0;

  try {
    const result = await generateText({
      prompt: userMessage,
      systemPrompt: SYSTEM_PROMPT,
      model,
      temperature: 0.4,
      maxTokens: 2048,
      jsonMode: true,
    });

    tokensUsed = (result.tokensUsed.input ?? 0) + (result.tokensUsed.output ?? 0);
    const parsed = parseClaudeJson(result.text);
    const latencyMs = Date.now() - startMs;

    // -- Log to ai_schedule_logs (fire-and-forget with admin client)
    const adminDb = getAdminClient();
    adminDb.from("ai_schedule_logs").insert({
      student_id: user.id,
      institution_id: institutionId ?? null,
      action,
      model,
      status: "success",
      tokens_used: tokensUsed,
      latency_ms: latencyMs,
    }).then(({ error: logErr }) => {
      if (logErr) console.error("[Schedule Agent] Log insert error:", logErr.message);
    });

    return ok(c, {
      result: parsed,
      _meta: {
        aiPowered: true,
        model: getModelId(model),
        tokensUsed,
        latencyMs,
        action,
      },
    });
  } catch (e) {
    const latencyMs = Date.now() - startMs;
    const errMsg = (e instanceof Error ? e.message : String(e)).slice(0, 500);

    console.error(`[Schedule Agent] Claude error (${action}):`, errMsg);

    // -- Log failure
    const adminDb = getAdminClient();
    adminDb.from("ai_schedule_logs").insert({
      student_id: user.id,
      institution_id: institutionId ?? null,
      action,
      model,
      status: "error",
      tokens_used: tokensUsed,
      latency_ms: latencyMs,
      error_message: errMsg,
      fallback_reason: "claude_error",
    }).then(({ error: logErr }) => {
      if (logErr) console.error("[Schedule Agent] Log insert error:", logErr.message);
    });

    // Return graceful fallback response so frontend can handle it
    return ok(c, {
      result: null,
      _meta: {
        aiPowered: false,
        model: getModelId(model),
        tokensUsed: 0,
        latencyMs,
        action,
        error: errMsg,
      },
    });
  }
});

// -- GET /ai/schedule-logs — Fetch logs for the authenticated user's institution
aiScheduleAgentRoutes.get(`${PREFIX}/ai/schedule-logs`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const institutionId = c.req.query("institution_id");

  // If institution_id provided, check RBAC
  if (institutionId) {
    const roleCheck = await requireInstitutionRole(
      db, user.id, institutionId, ALL_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }
  }

  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10), 0);

  let query = db
    .from("ai_schedule_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (institutionId) {
    query = query.eq("institution_id", institutionId);
  } else {
    // Without institution_id, only show own logs (RLS enforces this too)
    query = query.eq("student_id", user.id);
  }

  const { data, error: fetchErr } = await query;

  if (fetchErr) return safeErr(c, "Fetch schedule logs", fetchErr);

  return ok(c, { logs: data ?? [], count: data?.length ?? 0 });
});
