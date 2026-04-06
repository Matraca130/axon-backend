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
 * ENRICHMENT (v2): The backend now queries the database for the student's
 * actual tasks, mastery states, and recent activity — the AI sees the REAL
 * state, not just what the frontend sends.
 *
 * Uses Claude to generate personalized study schedules for medical students.
 * Logs every invocation to ai_schedule_logs for analytics.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { authenticate, ok, err, safeJson, getAdminClient, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { generateText, parseClaudeJson, getModelId, type ClaudeModel } from "../../claude-ai.ts";

export const aiScheduleAgentRoutes = new Hono();

// Dedicated rate limit: 30 requests per hour for schedule agent
const SCHEDULE_RATE_LIMIT = 30;
const SCHEDULE_RATE_WINDOW_MS = 3600000;

const VALID_ACTIONS = ["distribute", "recommend-today", "reschedule", "weekly-insight", "organize"] as const;
type ScheduleAction = typeof VALID_ACTIONS[number];

// ── DB context fetcher ─────────────────────────────────────────────
// Queries the student's REAL state from the database so the AI sees
// actual tasks, mastery, and activity — not just the frontend payload.

interface DbStudentContext {
  pendingTasks: Array<{
    id: string;
    item_type: string;
    status: string;
    original_method: string | null;
    scheduled_date: string | null;
    estimated_minutes: number | null;
    task_kind: string | null;
    plan_name: string;
    plan_status: string;
  }>;
  completedTodayCount: number;
  blockMastery: Array<{ block_id: string; p_know: number }>;
  recentActivity: Array<{
    date: string;
    study_minutes: number;
    sessions_count: number;
  }>;
  weakTopics: string[];
}

async function fetchStudentContext(
  db: SupabaseClient,
  userId: string,
): Promise<DbStudentContext> {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  // Run all queries in parallel
  const [tasksRes, completedRes, masteryRes, activityRes, weakRes] = await Promise.all([
    // 1. Pending tasks from all active plans (max 100)
    db
      .from("study_plan_tasks")
      .select("id, item_type, status, original_method, scheduled_date, estimated_minutes, task_kind, study_plans!inner(name, status)")
      .eq("status", "pending")
      .eq("study_plans.student_id", userId)
      .in("study_plans.status", ["active", "in_progress"])
      .order("scheduled_date", { ascending: true, nullsFirst: false })
      .limit(100),

    // 2. Tasks completed today
    db
      .from("study_plan_tasks")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .gte("completed_at", `${today}T00:00:00`)
      .lte("completed_at", `${today}T23:59:59`),

    // 3. Block mastery states (latest per block)
    db
      .from("block_mastery_states")
      .select("block_id, p_know")
      .eq("student_id", userId)
      .order("last_attempt_at", { ascending: false })
      .limit(50),

    // 4. Daily activity last 7 days
    db
      .from("daily_activities")
      .select("date, study_minutes, sessions_count")
      .eq("student_id", userId)
      .gte("date", sevenDaysAgo)
      .order("date", { ascending: false }),

    // 5. Weak topics via BKT (p_know < 0.4)
    db
      .from("bkt_states")
      .select("subtopic_id, p_know, subtopics!inner(name)")
      .eq("student_id", userId)
      .lt("p_know", 0.4)
      .order("p_know", { ascending: true })
      .limit(20),
  ]);

  const pendingTasks = (tasksRes.data ?? []).map((t: any) => ({
    id: t.id,
    item_type: t.item_type,
    status: t.status,
    original_method: t.original_method,
    scheduled_date: t.scheduled_date,
    estimated_minutes: t.estimated_minutes,
    task_kind: t.task_kind,
    plan_name: t.study_plans?.name ?? "Sin nombre",
    plan_status: t.study_plans?.status ?? "unknown",
  }));

  return {
    pendingTasks,
    completedTodayCount: completedRes.count ?? 0,
    blockMastery: (masteryRes.data ?? []).map((m: any) => ({
      block_id: m.block_id,
      p_know: m.p_know,
    })),
    recentActivity: (activityRes.data ?? []).map((a: any) => ({
      date: a.date,
      study_minutes: a.study_minutes ?? 0,
      sessions_count: a.sessions_count ?? 0,
    })),
    weakTopics: (weakRes.data ?? []).map(
      (w: any) => `${w.subtopics?.name ?? "Tema desconocido"} (p_know: ${w.p_know})`,
    ),
  };
}

const SYSTEM_PROMPT = `Eres un tutor medico experto en optimizacion de estudio y repeticion espaciada. Analizas el perfil de un estudiante de medicina y generas planes de estudio personalizados.

REGLAS:
1. Prioriza temas con bajo dominio (masteryPercent < 40) con mas tiempo y frecuencia
2. Alterna metodos de estudio (no 3 flashcards seguidas)
3. Fatiga cognitiva: temas dificiles temprano, ligeros al final de semana
4. Respeta weeklyHours del alumno
5. Temas needsReview=true van primero
6. Estima tiempos del historial del alumno, no promedios generales
7. ANALIZA LAS TAREAS PENDIENTES del alumno — no recomiendes lo que ya esta programado
8. Considera los temas debiles (weakTopics con bajo p_know) como prioridad alta
9. Si el alumno ya completo tareas hoy, ajusta las recomendaciones al tiempo restante
10. Usa la actividad reciente (7 dias) para detectar patrones de estudio del alumno

RESPONDE EXCLUSIVAMENTE en JSON valido sin markdown.`;

function buildUserMessage(
  action: ScheduleAction,
  studentProfile: Record<string, unknown>,
  dbContext: DbStudentContext,
  planContext?: Record<string, unknown>,
  completedTaskId?: string,
): string {
  const profileStr = JSON.stringify(studentProfile);

  const contextBlock = `
== DATOS REALES DEL ESTUDIANTE (base de datos) ==

Tareas pendientes (${dbContext.pendingTasks.length}):
${dbContext.pendingTasks.length > 0
    ? JSON.stringify(dbContext.pendingTasks.slice(0, 30))
    : "Ninguna tarea pendiente en planes activos."}

Tareas completadas hoy: ${dbContext.completedTodayCount}

Temas debiles (bajo dominio):
${dbContext.weakTopics.length > 0 ? dbContext.weakTopics.join(", ") : "Sin datos de temas debiles."}

Actividad ultimos 7 dias:
${dbContext.recentActivity.length > 0
    ? dbContext.recentActivity.map((a) => `${a.date}: ${a.study_minutes}min, ${a.sessions_count} sesiones`).join("\n")
    : "Sin actividad registrada."}

Dominio por bloque (${dbContext.blockMastery.length} bloques con datos):
${dbContext.blockMastery.length > 0
    ? `Promedio p_know: ${(dbContext.blockMastery.reduce((s, m) => s + m.p_know, 0) / dbContext.blockMastery.length).toFixed(3)}`
    : "Sin datos de mastery por bloque."}
`;

  switch (action) {
    case "distribute":
      return `Distribuye estas tareas de estudio de forma optima para este alumno.

Plan y tareas pendientes:
${JSON.stringify(planContext ?? {})}

${contextBlock}

Perfil del alumno (frontend):
${profileStr}

Responde con JSON: { "schedule": [ { "day": "lunes", "blocks": [ { "startTime": "08:00", "duration_min": 30, "taskType": "flashcard"|"quiz"|"read"|"review", "topicId": "...", "topicName": "...", "reason": "..." } ] } ], "totalHours": number, "tips": ["..."] }`;

    case "recommend-today":
      return `Recomienda que estudiar hoy para este alumno de medicina.

${contextBlock}

Perfil del alumno (frontend):
${profileStr}

IMPORTANTE: Toma en cuenta las tareas que YA tiene pendientes para hoy. No dupliques lo que ya esta programado. Si tiene tareas para hoy, prioriza esas. Si ya completo algunas, sugiere las siguientes. Si no tiene plan, recomienda basandote en sus temas debiles y mastery.

Responde con JSON: { "recommendations": [ { "priority": 1, "taskType": "flashcard"|"quiz"|"read"|"review", "topicId": "...", "topicName": "...", "estimatedMinutes": number, "reason": "..." } ], "totalMinutes": number, "motivationalNote": "..." }`;

    case "reschedule":
      return `El alumno completo la tarea "${completedTaskId || "desconocida"}". Redistribuye las tareas pendientes considerando este progreso.

Tareas y plan actual:
${JSON.stringify(planContext ?? {})}

${contextBlock}

Perfil del alumno (frontend):
${profileStr}

Responde con JSON: { "updatedSchedule": [ { "day": "...", "blocks": [ { "startTime": "...", "duration_min": number, "taskType": "...", "topicId": "...", "topicName": "...", "reason": "..." } ] } ], "adjustmentReason": "...", "nextPriority": "..." }`;

    case "weekly-insight":
      return `Genera un analisis semanal del progreso de este alumno de medicina.

${contextBlock}

Perfil del alumno (frontend):
${profileStr}

Responde con JSON: { "weekSummary": "...", "strengths": ["..."], "weaknesses": ["..."], "masteryTrend": "improving"|"stable"|"declining", "recommendedFocus": [ { "topicName": "...", "reason": "...", "suggestedMethod": "..." } ], "estimatedWeeklyProgress": number }`;

    case "organize":
      return `Analiza las tareas pendientes de este alumno y REORGANIZA su plan de estudio de forma optima. Puedes ejecutar estas operaciones:

1. REORDER: Reordenar tareas por prioridad (temas debiles primero, alternando metodos)
2. RESCHEDULE: Cambiar la fecha programada de tareas
3. DELETE: Eliminar tareas duplicadas, irrelevantes o ya dominadas
4. UPDATE: Cambiar metodo de estudio o duracion estimada

${contextBlock}

Perfil del alumno (frontend):
${profileStr}

INSTRUCCIONES:
- Analiza TODAS las tareas pendientes
- Elimina tareas duplicadas o de temas ya dominados (p_know > 0.85)
- Reorganiza priorizando: temas debiles > needsReview > alternancia de metodos
- Reagenda tareas sin fecha o con fechas pasadas para los proximos 7 dias
- Respeta fatiga cognitiva: maximo 3 horas/dia, temas dificiles temprano

Responde con JSON:
{
  "operations": [
    { "op": "delete", "taskId": "uuid", "reason": "..." },
    { "op": "reorder", "taskId": "uuid", "newIndex": number, "reason": "..." },
    { "op": "reschedule", "taskId": "uuid", "newDate": "YYYY-MM-DD", "reason": "..." },
    { "op": "update", "taskId": "uuid", "fields": { "estimated_minutes": number, "original_method": "string", "task_kind": "string" }, "reason": "..." }
  ],
  "summary": "Descripcion breve de los cambios realizados",
  "rationale": "Por que se hicieron estos cambios"
}`;
  }
}

// ── Execute AI-generated operations on study_plan_tasks ────────────
// The AI returns an array of operations (delete, reorder, reschedule, update).
// We execute each one, verifying ownership through the study_plans join.

// Safety cap: prevents DoS via large AI-generated operation batches.
// 50 ops ≈ ~10s at ~200ms/op (ownership check + update per op).
const MAX_OPS = 50;

interface AiOperation {
  op: string;
  taskId: string;
  reason?: string;
  newIndex?: number;
  newDate?: string;
  fields?: Record<string, unknown>;
}

async function executeAiOperations(
  db: SupabaseClient,
  userId: string,
  operations: AiOperation[],
): Promise<Array<{ op: string; taskId: string; success: boolean; error?: string }>> {
  const results: Array<{ op: string; taskId: string; success: boolean; error?: string }> = [];
  const ops = operations.slice(0, MAX_OPS);

  // Helper: builds a query scoped to tasks owned by this user (atomic ownership check).
  // RLS also enforces this, but the explicit join is defense-in-depth.
  const ownedTask = (taskId: string) =>
    db.from("study_plan_tasks")
      .select("id, study_plan_id, study_plans!inner(student_id)")
      .eq("id", taskId)
      .eq("study_plans.student_id", userId)
      .maybeSingle();

  for (const op of ops) {
    if (!op.taskId) {
      results.push({ op: op.op, taskId: op.taskId, success: false, error: "Missing taskId" });
      continue;
    }

    try {
      // Verify ownership atomically per operation
      const { data: task } = await ownedTask(op.taskId);
      if (!task) {
        results.push({ op: op.op, taskId: op.taskId, success: false, error: "Task not found or not owned" });
        continue;
      }

      switch (op.op) {
        case "delete": {
          const { error: delErr } = await db
            .from("study_plan_tasks")
            .delete()
            .eq("id", op.taskId);
          results.push({ op: "delete", taskId: op.taskId, success: !delErr, error: delErr?.message });
          break;
        }

        case "reorder": {
          if (typeof op.newIndex !== "number") {
            results.push({ op: "reorder", taskId: op.taskId, success: false, error: "newIndex required" });
            break;
          }
          const { error: reorderErr } = await db
            .from("study_plan_tasks")
            .update({ order_index: op.newIndex })
            .eq("id", op.taskId);
          results.push({ op: "reorder", taskId: op.taskId, success: !reorderErr, error: reorderErr?.message });
          break;
        }

        case "reschedule": {
          if (!op.newDate) {
            results.push({ op: "reschedule", taskId: op.taskId, success: false, error: "newDate required" });
            break;
          }
          const { error: schedErr } = await db
            .from("study_plan_tasks")
            .update({ scheduled_date: op.newDate })
            .eq("id", op.taskId);
          results.push({ op: "reschedule", taskId: op.taskId, success: !schedErr, error: schedErr?.message });
          break;
        }

        case "update": {
          if (!op.fields || typeof op.fields !== "object") {
            results.push({ op: "update", taskId: op.taskId, success: false, error: "fields required" });
            break;
          }
          const allowedFields = ["estimated_minutes", "original_method", "task_kind", "scheduled_date", "order_index"];
          const safeFields: Record<string, unknown> = {};
          for (const key of allowedFields) {
            if (key in op.fields) safeFields[key] = op.fields[key];
          }
          if (Object.keys(safeFields).length === 0) {
            results.push({ op: "update", taskId: op.taskId, success: false, error: "No valid fields" });
            break;
          }
          const { error: updErr } = await db
            .from("study_plan_tasks")
            .update(safeFields)
            .eq("id", op.taskId);
          results.push({ op: "update", taskId: op.taskId, success: !updErr, error: updErr?.message });
          break;
        }

        default:
          results.push({ op: op.op, taskId: op.taskId, success: false, error: `Unknown op: ${op.op}` });
      }
    } catch (e) {
      results.push({ op: op.op, taskId: op.taskId, success: false, error: (e as Error).message });
    }
  }

  const truncated = operations.length > MAX_OPS;
  if (truncated) {
    console.warn(`[Schedule Agent] Organize: truncated ${operations.length} ops to ${MAX_OPS}`);
  }
  console.log(`[Schedule Agent] Organize: ${results.filter((r) => r.success).length}/${results.length} ops succeeded`);
  return results;
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

  // -- Fetch real student context from DB (tasks, mastery, activity)
  let dbContext: DbStudentContext;
  let degradedMode = false;
  try {
    dbContext = await fetchStudentContext(db, user.id);
  } catch (e) {
    console.warn("[Schedule Agent] DB context fetch failed, proceeding with empty context:", e);
    dbContext = { pendingTasks: [], completedTodayCount: 0, blockMastery: [], recentActivity: [], weakTopics: [] };
    degradedMode = true;
  }

  // -- Build prompt and call Claude
  const userMessage = buildUserMessage(
    action as ScheduleAction,
    studentProfile,
    dbContext,
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

    // -- Execute AI operations for "organize" action
    let executionResults: Array<{ op: string; taskId: string; success: boolean; error?: string }> | undefined;
    if (action === "organize" && parsed?.operations && Array.isArray(parsed.operations)) {
      executionResults = await executeAiOperations(db, user.id, parsed.operations);
    }

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
      executionResults,
      _meta: {
        aiPowered: true,
        model: getModelId(model),
        tokensUsed,
        latencyMs,
        action,
        degradedMode,
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
