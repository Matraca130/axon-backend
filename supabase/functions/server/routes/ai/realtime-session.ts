/**
 * routes/ai/realtime-session.ts — OpenAI Realtime session bootstrap
 *
 * POST /ai/realtime-session
 *   summary_id?: UUID (optional, scope context to current summary)
 *
 * Creates an ephemeral OpenAI Realtime API session pre-loaded with the
 * student's full academic context (knowledge profile, stats, XP, current topic).
 *
 * Architecture:
 *   1. Authenticate + resolve institution
 *   2. Gather student context (knowledge profile, stats, XP, summary info)
 *   3. Build personalized system prompt with all context
 *   4. POST to OpenAI /v1/realtime/sessions for ephemeral client_secret
 *   5. Return { client_secret, expires_at } to frontend
 *
 * The frontend connects DIRECTLY to OpenAI's WebSocket using the ephemeral
 * token. Tools are executed client-side against existing backend APIs.
 *
 * Security:
 *   - OPENAI_API_KEY never reaches the client
 *   - Ephemeral token expires in ~60s (OpenAI default)
 *   - Rate-limited by AI middleware in index.ts
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX, getAdminClient } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { sanitizeForPrompt, wrapXml } from "../../prompt-sanitize.ts";

export const aiRealtimeRoutes = new Hono();

// ── Tool Definitions (extensible registry) ────────────────────────────
// To add a new tool: append an object to this array.
// The frontend TOOL_EXECUTORS map must also have a matching entry.

const REALTIME_TOOLS = [
  {
    type: "function" as const,
    name: "search_course_content",
    description:
      "Busca información en el material de estudio del curso del alumno. " +
      "Usa esta herramienta cuando el alumno pregunte algo sobre el contenido " +
      "académico y necesites buscar en sus apuntes, resúmenes o material del curso.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "La pregunta o término de búsqueda sobre el contenido del curso",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function" as const,
    name: "get_study_queue",
    description:
      "Obtiene las flashcards más urgentes que el alumno debería estudiar, " +
      "priorizadas por NeedScore (combina urgencia, dominio y fragilidad). " +
      "Usa esta herramienta cuando el alumno pregunte qué debería estudiar o repasar.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Cantidad máxima de flashcards a retornar (default: 5)",
        },
      },
    },
  },
];

// ── System Prompt Builder ─────────────────────────────────────────────

interface StudentContext {
  knowledgeProfile: Record<string, unknown> | null;
  summaryTitle: string | null;
  courseName: string | null;
  stats: { current_streak: number; total_reviews: number; total_time_seconds: number } | null;
  xp: { total_xp: number; current_level: number; xp_today: number } | null;
}

function buildSystemPrompt(ctx: StudentContext): string {
  const parts: string[] = [];

  parts.push(
    `Eres el tutor de voz de Axon, una plataforma educativa. ` +
    `Hablas en español de forma cálida, amable y motivadora. ` +
    `Eres conciso en tus respuestas de voz (máximo 3-4 oraciones por turno). ` +
    `Adapta tu explicación al nivel del alumno.`
  );

  // Current topic context
  if (ctx.summaryTitle || ctx.courseName) {
    const topic = [ctx.courseName, ctx.summaryTitle].filter(Boolean).join(" → ");
    parts.push(`\nTema actual del alumno: ${topic}`);
  }

  // Knowledge profile
  if (ctx.knowledgeProfile) {
    const kp = ctx.knowledgeProfile;
    const sections: string[] = [];

    if (Array.isArray(kp.weak) && kp.weak.length > 0) {
      const weakList = kp.weak
        .map((w: Record<string, unknown>) => `${sanitizeForPrompt(String(w.sub), 100)} (dominio: ${w.p})`)
        .join(", ");
      sections.push(`Áreas débiles: ${weakList}`);
    }

    if (Array.isArray(kp.strong) && kp.strong.length > 0) {
      const strongList = kp.strong
        .map((s: Record<string, unknown>) => `${sanitizeForPrompt(String(s.sub), 100)} (dominio: ${s.p})`)
        .join(", ");
      sections.push(`Fortalezas: ${strongList}`);
    }

    if (Array.isArray(kp.lapsing) && kp.lapsing.length > 0) {
      const lapsingList = kp.lapsing
        .map((l: Record<string, unknown>) => `"${sanitizeForPrompt(String(l.card), 100)}" (${l.lapses} fallos)`)
        .join(", ");
      sections.push(`Flashcards problemáticas: ${lapsingList}`);
    }

    if (Array.isArray(kp.quiz_fail) && kp.quiz_fail.length > 0) {
      const failList = kp.quiz_fail
        .map((q: Record<string, unknown>) => `"${sanitizeForPrompt(String(q.q), 100)}"`)
        .join(", ");
      sections.push(`Quiz fallidos recientes: ${failList}`);
    }

    if (sections.length > 0) {
      parts.push(`\n${wrapXml("student_profile", `PERFIL ACADÉMICO DEL ALUMNO:\n- ${sections.join("\n- ")}`)}`);
    }
  }

  // Stats & XP
  const statParts: string[] = [];
  if (ctx.stats) {
    if (ctx.stats.current_streak > 0) statParts.push(`racha de ${ctx.stats.current_streak} días`);
    if (ctx.stats.total_reviews > 0) statParts.push(`${ctx.stats.total_reviews} revisiones totales`);
  }
  if (ctx.xp) {
    statParts.push(`nivel ${ctx.xp.current_level}`);
    statParts.push(`${ctx.xp.total_xp} XP`);
    if (ctx.xp.xp_today > 0) statParts.push(`${ctx.xp.xp_today} XP hoy`);
  }
  if (statParts.length > 0) {
    parts.push(`\nProgreso: ${statParts.join(", ")}`);
  }

  // Behavioral instructions
  parts.push(
    `\nINSTRUCCIONES DE COMPORTAMIENTO:` +
    `\n- Si el alumno tiene áreas débiles, ofrécete a explicarlas proactivamente.` +
    `\n- Felicita logros (racha, nivel, XP del día).` +
    `\n- Si pregunta qué estudiar, usa la herramienta get_study_queue.` +
    `\n- Si pregunta sobre el contenido del curso, usa search_course_content.` +
    `\n- Sé breve y natural — es una conversación de voz, no un ensayo.` +
    `\n- No repitas la información del perfil literalmente, úsala para contextualizar.`
  );

  return parts.join("\n");
}

// ── Route ─────────────────────────────────────────────────────────────

aiRealtimeRoutes.post(`${PREFIX}/ai/realtime-session`, async (c: Context) => {
  try {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  const summaryId = isUuid(body?.summary_id) ? (body.summary_id as string) : null;

  // 1. Resolve institution (same pattern as chat.ts)
  let institutionId: string | null = null;
  if (summaryId) {
    const { data: instId } = await db.rpc("resolve_parent_institution", {
      p_table: "summaries",
      p_id: summaryId,
    });
    institutionId = instId as string;
  }
  if (!institutionId) {
    const { data: membership } = await db
      .from("memberships")
      .select("institution_id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .limit(1)
      .single();
    institutionId = membership?.institution_id || null;
  }
  if (!institutionId) {
    return err(c, "No se pudo resolver la institución. El usuario no tiene membresías activas.", 400);
  }

  // 2. Verify role
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const adminDb = getAdminClient();

  // 3. Gather student context (parallel queries)
  // Note: Supabase PostgrestBuilder is a thenable but lacks .catch(),
  // so we wrap each query with Promise.resolve() to get a real Promise.
  const [knowledgeResult, summaryResult, statsResult, xpResult] = await Promise.all([
    // Knowledge profile (weak/strong/lapsing/quiz_fail)
    Promise.resolve(
      adminDb.rpc("get_student_knowledge_context", {
        p_student_id: user.id,
        p_institution_id: institutionId,
      })
    ).catch(() => ({ data: null })),

    // Summary + course info (if summary_id provided)
    summaryId
      ? Promise.resolve(
          adminDb
            .from("summaries")
            .select("title, topics!inner(title, sections!inner(title, semesters!inner(title, courses!inner(name))))")
            .eq("id", summaryId)
            .single()
        ).catch(() => ({ data: null }))
      : Promise.resolve({ data: null }),

    // Student stats
    Promise.resolve(
      adminDb
        .from("student_stats")
        .select("current_streak, total_reviews, total_time_seconds")
        .eq("student_id", user.id)
        .single()
    ).catch(() => ({ data: null })),

    // Student XP
    Promise.resolve(
      adminDb
        .from("student_xp")
        .select("total_xp, current_level, xp_today")
        .eq("student_id", user.id)
        .eq("institution_id", institutionId)
        .single()
    ).catch(() => ({ data: null })),
  ]);

  // Extract summary/course names from nested join
  let summaryTitle: string | null = null;
  let courseName: string | null = null;
  if (summaryResult.data) {
    const s = summaryResult.data as Record<string, unknown>;
    summaryTitle = s.title as string;
    const topic = s.topics as Record<string, unknown> | undefined;
    if (topic) {
      const section = topic.sections as Record<string, unknown> | undefined;
      if (section) {
        const semester = section.semesters as Record<string, unknown> | undefined;
        if (semester) {
          const course = semester.courses as Record<string, unknown> | undefined;
          if (course) courseName = course.name as string;
        }
      }
    }
  }

  // 4. Build personalized system prompt
  const systemPrompt = buildSystemPrompt({
    knowledgeProfile: knowledgeResult.data as Record<string, unknown> | null,
    summaryTitle,
    courseName,
    stats: statsResult.data as StudentContext["stats"],
    xp: xpResult.data as StudentContext["xp"],
  });

  // 5. Request ephemeral token from OpenAI
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    return err(c, "Clave de API de OpenAI no configurada", 500);
  }

  let sessionResponse: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    sessionResponse = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        voice: "coral",
        instructions: systemPrompt,
        tools: REALTIME_TOOLS,
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
        },
      }),
    });
  } catch (fetchErr) {
    console.error("[Realtime] OpenAI session request failed:", (fetchErr as Error).message);
    return err(c, "Error al crear sesión de voz", 502);
  } finally {
    clearTimeout(timeout);
  }

  if (!sessionResponse.ok) {
    const errorBody = await sessionResponse.text().catch(() => "");
    console.error("[Realtime] OpenAI error:", sessionResponse.status, errorBody.slice(0, 200));
    return err(c, `Error de sesión OpenAI: ${sessionResponse.status} — ${errorBody.slice(0, 300)}`, 502);
  }

  let session: Record<string, unknown>;
  try {
    session = await sessionResponse.json();
  } catch {
    return err(c, "Respuesta inválida de OpenAI", 502);
  }

  const clientSecret = (session.client_secret as Record<string, unknown>)?.value
    ?? session.client_secret;
  if (!clientSecret || typeof clientSecret !== "string") {
    console.error("[Realtime] Missing client_secret in OpenAI response:", JSON.stringify(session).slice(0, 200));
    return err(c, "OpenAI no devolvió un token de sesión válido", 502);
  }

  // 6. Return ephemeral token to frontend
  return ok(c, {
    client_secret: clientSecret,
    expires_at: (session.client_secret as Record<string, unknown>)?.expires_at ?? session.expires_at ?? null,
    model: "gpt-4o-realtime-preview",
    voice: "coral",
  });

  } catch (handlerErr) {
    const msg = (handlerErr as Error).message || String(handlerErr);
    const stack = (handlerErr as Error).stack || "";
    console.error("[Realtime] Unhandled error:", msg, "\n", stack);
    return err(c, `Error interno al crear sesión de voz: ${msg}`, 500);
  }
});
