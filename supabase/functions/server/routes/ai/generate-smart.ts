/**
 * routes/ai/generate-smart.ts — Adaptive AI content generation (Fase 8A)
 *
 * POST /ai/generate-smart
 *   action: "quiz_question" | "flashcard" (required)
 *   institution_id: UUID (optional, scopes to one institution)
 *   related: boolean (optional, default true, for flashcards)
 *
 * Unlike POST /ai/generate which requires the client to provide
 * summary_id + keyword_id, this endpoint AUTO-SELECTS the best
 * concept to study based on the student's BKT mastery profile.
 *
 * Flow:
 *   1. RPC get_smart_generate_target() → top 5 keyword targets
 *   2. Dedup check: skip keywords with recent AI content (2h window)
 *   3. Pick best target → build adaptive prompt → Gemini → insert → return
 *
 * Key differences from /ai/generate:
 *   - Client sends NO content IDs — the server chooses the best target
 *   - Prompt includes NeedScore context (why this concept was chosen)
 *   - Temperature is adaptive (lower for low mastery, higher for high)
 *   - No wrong_answer/block_id support (those are manual-generate features)
 *   - Response includes _smart metadata (target selection info)
 *
 * Architectural decisions: D1, D2, D3, D8, D10-D13
 * Error prevention: E1, E2, E7, E8, E9
 * Security: PF-05 (DB before Gemini), BUG-3 (institution scoping)
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid, isOneOf } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { generateText, parseGeminiJson, GENERATE_MODEL } from "../../gemini.ts";

export const aiGenerateSmartRoutes = new Hono();

const ACTIONS = ["quiz_question", "flashcard"] as const;

// ── D12: Local truncateAtWord (Fase 3 not yet on main) ────────
// LA-07 pattern: truncate respecting word boundaries.
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.substring(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > maxLen * 0.8
    ? truncated.substring(0, lastSpace) + "..."
    : truncated + "...";
}

// ── D13: Map primary_reason to Spanish explanation for prompt ──
function reasonToText(reason: string, pKnow: number): string {
  const pct = Math.round(pKnow * 100);
  switch (reason) {
    case "new_concept":
      return "Es un concepto nuevo que aun no has estudiado.";
    case "low_mastery":
      return `Tu dominio es bajo (${pct}%). Necesitas reforzar este concepto.`;
    case "needs_review":
      return `Tu dominio es moderado-bajo (${pct}%). Un repaso te ayudara a consolidar.`;
    case "moderate_mastery":
      return `Tu dominio es intermedio (${pct}%). Puedes profundizar con ejercicios mas desafiantes.`;
    case "reinforcement":
      return `Tu dominio es alto (${pct}%). Este ejercicio te ayudara a mantener el conocimiento.`;
    default:
      return `Concepto seleccionado para estudio (dominio: ${pct}%).`;
  }
}

// ── D10: Adaptive temperature based on mastery ────────────────
// Low mastery → clearer, more deterministic (0.5)
// Medium mastery → balanced (0.7)
// High mastery → creative, challenging (0.85)
function adaptiveTemperature(pKnow: number): number {
  if (pKnow < 0.3) return 0.5;
  if (pKnow < 0.7) return 0.7;
  return 0.85;
}

// ── RPC result type ───────────────────────────────────────────
interface SmartTarget {
  subtopic_id: string | null;
  subtopic_name: string | null;
  keyword_id: string;
  keyword_name: string;
  keyword_def: string | null;
  summary_id: string;
  summary_title: string;
  topic_id: string;
  p_know: number;
  need_score: number;
  primary_reason: string;
}

aiGenerateSmartRoutes.post(`${PREFIX}/ai/generate-smart`, async (c: Context) => {
  // ── Step 1: Auth (PF-05: must happen before Gemini) ────────
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  const action = body.action as string;
  if (!isOneOf(action, ACTIONS))
    return err(c, "action must be 'quiz_question' or 'flashcard'", 400);

  const institutionId = isUuid(body.institution_id)
    ? (body.institution_id as string)
    : null;
  const related = body.related !== false;

  // ── Step 2: RPC get_smart_generate_target (D1: top 5) ──────
  const { data: targets, error: rpcError } = await db.rpc(
    "get_smart_generate_target",
    {
      p_student_id: user.id,
      p_institution_id: institutionId,
    },
  );

  if (rpcError) {
    console.error("[GenerateSmart] RPC error:", rpcError.message);
    return err(c, `Smart target selection failed: ${rpcError.message}`, 500);
  }

  // E2 + E8: No targets available (no memberships or empty institution)
  if (!targets || targets.length === 0) {
    return err(
      c,
      "No study material available. Ensure you have an active membership " +
        "and your courses contain summaries with keywords.",
      404,
    );
  }

  // ── Step 3: Dedup check (D3, D11: by keyword_id, 2h window) ─
  // Avoid generating content for a concept that was recently generated.
  const targetKeywordIds = (targets as SmartTarget[]).map(
    (t) => t.keyword_id,
  );
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const dedupTable =
    action === "quiz_question" ? "quiz_questions" : "flashcards";

  const { data: recentItems } = await db
    .from(dedupTable)
    .select("keyword_id")
    .eq("created_by", user.id)
    .eq("source", "ai")
    .gte("created_at", twoHoursAgo)
    .in("keyword_id", targetKeywordIds);

  const recentKeywordIds = new Set(
    recentItems?.map((r: { keyword_id: string }) => r.keyword_id) ?? [],
  );

  // Pick the first target that hasn't been generated recently.
  // Fallback to targets[0] if ALL have recent content (graceful degradation).
  const chosen: SmartTarget =
    (targets as SmartTarget[]).find(
      (t) => !recentKeywordIds.has(t.keyword_id),
    ) ?? (targets[0] as SmartTarget);

  // ── Step 4: Institution scoping (PF-05, BUG-3 pattern) ─────
  // ⚠️ This DB call MUST happen before the Gemini API call.
  // authenticate() decodes JWT locally; the RPC validates the
  // cryptographic signature via PostgREST.
  const { data: resolvedInstId } = await db.rpc(
    "resolve_parent_institution",
    {
      p_table: "summaries",
      p_id: chosen.summary_id,
    },
  );
  if (!resolvedInstId)
    return err(c, "Summary not found or inaccessible", 404);

  const roleCheck = await requireInstitutionRole(
    db,
    user.id,
    resolvedInstId as string,
    ALL_ROLES,
  );
  if (isDenied(roleCheck))
    return err(c, roleCheck.message, roleCheck.status);

  // ── Step 5: Fetch context for prompt ───────────────────────
  // 5a. Summary content (for the prompt snippet)
  const { data: summary } = await db
    .from("summaries")
    .select("content_markdown")
    .eq("id", chosen.summary_id)
    .single();

  const contentSnippet = truncateAtWord(
    summary?.content_markdown || "",
    1500,
  );

  // 5b. Professor notes (INC-6 pattern from generate.ts)
  let profNotesContext = "";
  const { data: profNotes } = await db
    .from("kw_prof_notes")
    .select("note")
    .eq("keyword_id", chosen.keyword_id)
    .limit(3);

  if (profNotes && profNotes.length > 0) {
    profNotesContext =
      "\nNotas del profesor: " +
      profNotes.map((n: { note: string }) => n.note).join("; ");
  }

  // 5c. Student knowledge profile
  let profileContext = "";
  const { data: profile } = await db.rpc("get_student_knowledge_context", {
    p_student_id: user.id,
    p_institution_id: resolvedInstId as string,
  });
  if (profile) {
    profileContext = `\nPerfil del alumno: ${JSON.stringify(profile)}`;
  }

  // 5d. BKT state for this subtopic (if available)
  let bktContext = "";
  if (chosen.subtopic_id) {
    const { data: bkt } = await db
      .from("bkt_states")
      .select("p_know, total_attempts, correct_attempts")
      .eq("student_id", user.id)
      .eq("subtopic_id", chosen.subtopic_id)
      .maybeSingle();
    if (bkt) {
      bktContext = `\nBKT del subtema: p_know=${bkt.p_know}, intentos=${bkt.total_attempts}, correctos=${bkt.correct_attempts}`;
    }
  }

  // ── Step 6: Build adaptive prompt ──────────────────────────
  const reasonText = reasonToText(
    chosen.primary_reason,
    Number(chosen.p_know),
  );
  const pKnow = Number(chosen.p_know);

  const systemPrompt =
    "Eres un tutor educativo adaptativo. Genera contenido " +
    "personalizado segun el nivel de dominio del alumno.\n" +
    "Responde SOLO con JSON valido, sin explicaciones adicionales.";

  let userPrompt = "";

  if (action === "quiz_question") {
    userPrompt = `Genera UNA pregunta de quiz adaptada al nivel del alumno.

Seleccion automatica: ${reasonText}

Tema: ${chosen.summary_title}
Keyword: ${chosen.keyword_name}${chosen.keyword_def ? ` — ${chosen.keyword_def}` : ""}
${chosen.subtopic_name ? `Subtema: ${chosen.subtopic_name}` : ""}
${profNotesContext}
Contenido relevante: ${contentSnippet}
${profileContext}
${bktContext}

Adapta la dificultad segun el dominio (${Math.round(pKnow * 100)}%):
- Dominio bajo (<30%): preguntas conceptuales basicas, definiciones
- Dominio medio (30-70%): preguntas de aplicacion y relacion entre conceptos
- Dominio alto (>70%): preguntas de analisis, sintesis o casos limite

Responde en JSON con este schema exacto:
{
  "question_type": "multiple_choice",
  "question": "texto de la pregunta",
  "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
  "correct_answer": "A",
  "explanation": "por que es correcta",
  "difficulty": "easy|medium|hard"
}`;
  } else {
    // flashcard
    const scope = related
      ? `Genera una flashcard RELACIONADA al keyword "${chosen.keyword_name}".`
      : `Genera una flashcard GENERAL del resumen "${chosen.summary_title}".`;

    userPrompt = `${scope}

Seleccion automatica: ${reasonText}

Keyword: ${chosen.keyword_name}${chosen.keyword_def ? ` — ${chosen.keyword_def}` : ""}
${chosen.subtopic_name ? `Subtema: ${chosen.subtopic_name}` : ""}
${profNotesContext}
Contenido relevante: ${contentSnippet}
${profileContext}

Adapta el contenido segun el dominio (${Math.round(pKnow * 100)}%):
- Dominio bajo: definiciones claras y conceptos fundamentales
- Dominio medio: relaciones entre conceptos y comparaciones
- Dominio alto: excepciones, casos limite y aplicaciones avanzadas

Responde en JSON con este schema exacto:
{
  "front": "pregunta o concepto",
  "back": "respuesta o explicacion"
}`;
  }

  // ── Step 7: Gemini call + insert ───────────────────────────
  try {
    const result = await generateText({
      prompt: userPrompt,
      systemPrompt,
      jsonMode: true,
      temperature: adaptiveTemperature(pKnow), // D10
      maxTokens: 1024,
    });

    const generated = parseGeminiJson(result.text);

    // ── Step 8: Insert into DB ─────────────────────────────
    if (action === "quiz_question") {
      const g = generated as Record<string, unknown>;
      const { data: inserted, error: insertErr } = await db
        .from("quiz_questions")
        .insert({
          summary_id: chosen.summary_id,
          keyword_id: chosen.keyword_id,
          subtopic_id: chosen.subtopic_id,
          question_type: g.question_type || "multiple_choice",
          question: g.question,
          options: g.options || null,
          correct_answer: g.correct_answer,
          explanation: g.explanation || null,
          difficulty: g.difficulty || "medium",
          source: "ai",
          created_by: user.id, // BUG-1 pattern
        })
        .select()
        .single();

      if (insertErr)
        return err(
          c,
          `Insert quiz_question failed: ${insertErr.message}`,
          500,
        );

      return ok(
        c,
        {
          ...inserted,
          _meta: {
            model: GENERATE_MODEL, // D-18 pattern
            tokens: result.tokensUsed,
          },
          _smart: {
            target_keyword: chosen.keyword_name,
            target_summary: chosen.summary_title,
            target_subtopic: chosen.subtopic_name,
            p_know: pKnow,
            need_score: Number(chosen.need_score),
            primary_reason: chosen.primary_reason,
            was_deduped: recentKeywordIds.has(chosen.keyword_id),
            candidates_evaluated: (targets as SmartTarget[]).length,
          },
        },
        201,
      );
    } else {
      // flashcard
      const g = generated as Record<string, unknown>;
      const { data: inserted, error: insertErr } = await db
        .from("flashcards")
        .insert({
          summary_id: chosen.summary_id,
          keyword_id: chosen.keyword_id,
          subtopic_id: chosen.subtopic_id,
          front: g.front,
          back: g.back,
          source: "ai",
          created_by: user.id, // BUG-1 pattern
        })
        .select()
        .single();

      if (insertErr)
        return err(
          c,
          `Insert flashcard failed: ${insertErr.message}`,
          500,
        );

      return ok(
        c,
        {
          ...inserted,
          _meta: {
            model: GENERATE_MODEL, // D-18 pattern
            tokens: result.tokensUsed,
            related,
          },
          _smart: {
            target_keyword: chosen.keyword_name,
            target_summary: chosen.summary_title,
            target_subtopic: chosen.subtopic_name,
            p_know: pKnow,
            need_score: Number(chosen.need_score),
            primary_reason: chosen.primary_reason,
            was_deduped: recentKeywordIds.has(chosen.keyword_id),
            candidates_evaluated: (targets as SmartTarget[]).length,
          },
        },
        201,
      );
    }
  } catch (e) {
    console.error("[GenerateSmart] Gemini error:", e);
    return err(c, `AI generation failed: ${(e as Error).message}`, 500);
  }
});
