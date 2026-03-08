/**
 * routes/ai/generate-smart.ts — Adaptive AI content generation (Fase 8A + 8E)
 *
 * POST /ai/generate-smart
 *   action: "quiz_question" | "flashcard" (required)
 *   institution_id: UUID (optional, scopes to one institution)
 *   related: boolean (optional, default true, for flashcards)
 *   summary_id: UUID (optional, Fase 8E: scopes to one summary)
 *   count: number (optional, Fase 8E: 1-10, default 1)
 *   quiz_id: UUID (optional, Fase 8E: auto-link questions to quiz)
 *
 * Unlike POST /ai/generate which requires the client to provide
 * summary_id + keyword_id, this endpoint AUTO-SELECTS the best
 * concept to study based on the student's BKT mastery profile.
 *
 * Flow (count=1, legacy):
 *   1. RPC get_smart_generate_target() → top targets
 *   2. Dedup check: skip subtopics with recent AI content (2h window)
 *   3. Pick best target → build adaptive prompt → Gemini → insert → return
 *
 * Flow (count>1, Fase 8E bulk):
 *   1. RPC get_smart_generate_target(p_limit=count+5) → targets with buffer
 *   2. Dedup check: filter out recently generated subtopics
 *   3. Pre-fetch shared context (summary, institution, profile)
 *   4. Sequential Gemini calls per target (D15 pattern from pre-generate)
 *   5. Partial-success response (D16 pattern from pre-generate)
 *
 * Key differences from /ai/generate:
 *   - Client sends NO content IDs — the server chooses the best target
 *   - Prompt includes NeedScore context (why this concept was chosen)
 *   - Temperature is adaptive (lower for low mastery, higher for high)
 *   - No wrong_answer/block_id support (those are manual-generate features)
 *   - Response includes _smart metadata (target selection info)
 *
 * Fase 8E additions:
 *   - summary_id: scopes RPC to one summary (for same-summary adaptive quiz)
 *   - count: generates up to 10 items in one request (sequential Gemini calls)
 *   - quiz_id: auto-links generated quiz_questions to a quiz entity
 *
 * Dedup granularity (Fase 8F):
 *   - Primary: subtopic_id (most targets have one after v2 migration)
 *   - Fallback: keyword_id (for targets without subtopic_id)
 *   - This ensures one generated subtopic doesn't block sibling subtopics
 *
 * Architectural decisions: D1, D2, D3, D8, D10-D13
 * Error prevention: E1, E2, E7, E8, E9
 * Security: PF-05 (DB before Gemini), BUG-3 (institution scoping)
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid, isOneOf, isNonNegInt } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { generateText, parseGeminiJson, GENERATE_MODEL } from "../../gemini.ts";

export const aiGenerateSmartRoutes = new Hono();

const ACTIONS = ["quiz_question", "flashcard"] as const;

// Fase 8E: Max items per bulk request
const MAX_BULK_COUNT = 10;

// ── D12: Local truncateAtWord (Fase 3 not yet on main) ────────
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

// ── Fase 8E: Bulk response types ─────────────────────────────
interface BulkGeneratedItem {
  type: string;
  id: string;
  keyword_id: string;
  keyword_name: string;
  summary_id: string;
  _smart: {
    p_know: number;
    need_score: number;
    primary_reason: string;
    target_subtopic: string | null;
  };
}

interface BulkErrorItem {
  keyword_id: string;
  keyword_name: string;
  error: string;
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

  // ── Fase 8E: New optional params ─────────────────────────────
  const summaryId = isUuid(body.summary_id)
    ? (body.summary_id as string)
    : null;

  let count = 1;
  if (body.count !== undefined) {
    if (!isNonNegInt(body.count) || (body.count as number) < 1)
      return err(c, `count must be an integer between 1 and ${MAX_BULK_COUNT}`, 400);
    count = Math.min(body.count as number, MAX_BULK_COUNT);
  }

  const quizId = isUuid(body.quiz_id)
    ? (body.quiz_id as string)
    : null;

  // ── Step 2: RPC get_smart_generate_target ───────────────────
  // Fase 8E: Pass p_summary_id and p_limit (with dedup buffer)
  const rpcLimit = Math.min(count + 5, 20);
  const { data: targets, error: rpcError } = await db.rpc(
    "get_smart_generate_target",
    {
      p_student_id: user.id,
      p_institution_id: institutionId,
      p_summary_id: summaryId,
      p_limit: rpcLimit,
    },
  );

  if (rpcError) {
    console.error("[GenerateSmart] RPC error:", rpcError.message);
    return err(c, `Smart target selection failed: ${rpcError.message}`, 500);
  }

  // E2 + E8: No targets available
  if (!targets || targets.length === 0) {
    const scopeMsg = summaryId
      ? "No keywords found for this summary."
      : "No study material available. Ensure you have an active membership " +
        "and your courses contain summaries with keywords.";
    return err(c, scopeMsg, 404);
  }

  // ── Step 3: Dedup check (Fase 8F: subtopic-level, 2h window) ─
  // Subtopic-level dedup: prevents blocking all subtopics of a keyword
  // when only one was recently generated. Falls back to keyword_id
  // for targets without subtopic_id.
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const dedupTable =
    action === "quiz_question" ? "quiz_questions" : "flashcards";

  // Primary: subtopic-level dedup (most targets have subtopic_id after v2)
  const targetSubtopicIds = (targets as SmartTarget[])
    .map((t) => t.subtopic_id)
    .filter((id): id is string => id !== null);

  const recentSubtopicIds = new Set<string>();
  if (targetSubtopicIds.length > 0) {
    const { data: recentBySubtopic } = await db
      .from(dedupTable)
      .select("subtopic_id")
      .eq("created_by", user.id)
      .eq("source", "ai")
      .gte("created_at", twoHoursAgo)
      .in("subtopic_id", targetSubtopicIds);

    for (const r of recentBySubtopic ?? []) {
      if (r.subtopic_id) recentSubtopicIds.add(r.subtopic_id as string);
    }
  }

  // Fallback: keyword-level dedup (for targets without subtopic_id)
  const keywordsWithoutSubtopic = [...new Set(
    (targets as SmartTarget[])
      .filter((t) => !t.subtopic_id)
      .map((t) => t.keyword_id),
  )];

  const recentKeywordIds = new Set<string>();
  if (keywordsWithoutSubtopic.length > 0) {
    const { data: recentByKeyword } = await db
      .from(dedupTable)
      .select("keyword_id")
      .eq("created_by", user.id)
      .eq("source", "ai")
      .gte("created_at", twoHoursAgo)
      .in("keyword_id", keywordsWithoutSubtopic);

    for (const r of recentByKeyword ?? []) {
      if (r.keyword_id) recentKeywordIds.add(r.keyword_id as string);
    }
  }

  // Unified dedup helper: subtopic if available, keyword fallback
  const isTargetDeduped = (t: SmartTarget): boolean => {
    if (t.subtopic_id) return recentSubtopicIds.has(t.subtopic_id);
    return recentKeywordIds.has(t.keyword_id);
  };

  // ════════════════════════════════════════════════════════════
  // SINGLE-ITEM PATH (count=1) — Legacy behavior preserved
  // ════════════════════════════════════════════════════════════
  if (count === 1) {
    // Pick the first target that hasn't been generated recently.
    // Fallback to targets[0] if ALL have recent content.
    const chosen: SmartTarget =
      (targets as SmartTarget[]).find(
        (t) => !isTargetDeduped(t),
      ) ?? (targets[0] as SmartTarget);

    // ── Step 4: Institution scoping (PF-05, BUG-3) ─────────
    const { data: resolvedInstId } = await db.rpc(
      "resolve_parent_institution",
      { p_table: "summaries", p_id: chosen.summary_id },
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

    // ── Step 5: Fetch context for prompt ─────────────────────
    const { data: summary } = await db
      .from("summaries")
      .select("content_markdown")
      .eq("id", chosen.summary_id)
      .single();

    const contentSnippet = truncateAtWord(
      summary?.content_markdown || "",
      1500,
    );

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

    let profileContext = "";
    const { data: profile } = await db.rpc("get_student_knowledge_context", {
      p_student_id: user.id,
      p_institution_id: resolvedInstId as string,
    });
    if (profile) {
      profileContext = `\nPerfil del alumno: ${JSON.stringify(profile)}`;
    }

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

    // ── Step 6: Build adaptive prompt ────────────────────────
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

    // ── Step 7: Gemini call + insert ─────────────────────────
    try {
      const result = await generateText({
        prompt: userPrompt,
        systemPrompt,
        jsonMode: true,
        temperature: adaptiveTemperature(pKnow),
        maxTokens: 1024,
      });

      const generated = parseGeminiJson(result.text);

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
            created_by: user.id,
            ...(quizId && { quiz_id: quizId }), // Fase 8E
          })
          .select()
          .single();

        if (insertErr)
          return err(c, `Insert quiz_question failed: ${insertErr.message}`, 500);

        return ok(
          c,
          {
            ...inserted,
            _meta: {
              model: GENERATE_MODEL,
              tokens: result.tokensUsed,
            },
            _smart: {
              target_keyword: chosen.keyword_name,
              target_summary: chosen.summary_title,
              target_subtopic: chosen.subtopic_name,
              p_know: pKnow,
              need_score: Number(chosen.need_score),
              primary_reason: chosen.primary_reason,
              was_deduped: isTargetDeduped(chosen),
              candidates_evaluated: (targets as SmartTarget[]).length,
            },
          },
          201,
        );
      } else {
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
            created_by: user.id,
          })
          .select()
          .single();

        if (insertErr)
          return err(c, `Insert flashcard failed: ${insertErr.message}`, 500);

        return ok(
          c,
          {
            ...inserted,
            _meta: {
              model: GENERATE_MODEL,
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
              was_deduped: isTargetDeduped(chosen),
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
  }

  // ════════════════════════════════════════════════════════════
  // BULK PATH (count > 1) — Fase 8E
  // Sequential Gemini calls with partial-success (D15, D16)
  // ════════════════════════════════════════════════════════════

  // Select targets: prefer non-deduped, take up to `count`
  const allTargets = targets as SmartTarget[];
  const freshTargets = allTargets.filter(
    (t) => !isTargetDeduped(t),
  );
  // Use fresh targets first; if not enough, pad with deduped ones (graceful)
  const selectedTargets = freshTargets.length >= count
    ? freshTargets.slice(0, count)
    : [
        ...freshTargets,
        ...allTargets
          .filter((t) => isTargetDeduped(t))
          .slice(0, count - freshTargets.length),
      ];

  // ── Pre-fetch shared context ───────────────────────────────
  // Cache summary content and institution IDs by summary_id.
  // When summary_id is provided, all targets share one summary → 1 fetch.
  // When global, targets may span multiple summaries → fetch per unique.
  const summaryContentCache = new Map<string, string>(); // summary_id -> content_markdown
  const institutionIdCache = new Map<string, string>();   // summary_id -> institution_id

  const uniqueSummaryIds = [...new Set(selectedTargets.map((t) => t.summary_id))];

  for (const sid of uniqueSummaryIds) {
    // PF-05: Institution check BEFORE any Gemini call
    const { data: instId } = await db.rpc("resolve_parent_institution", {
      p_table: "summaries",
      p_id: sid,
    });
    if (!instId) {
      return err(c, `Summary ${sid} not found or inaccessible`, 404);
    }

    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      instId as string,
      ALL_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }

    institutionIdCache.set(sid, instId as string);

    const { data: summaryData } = await db
      .from("summaries")
      .select("content_markdown")
      .eq("id", sid)
      .single();

    summaryContentCache.set(
      sid,
      truncateAtWord(summaryData?.content_markdown || "", 1500),
    );
  }

  // Fetch student profile once (same student for all targets)
  let sharedProfileContext = "";
  const firstInstId = institutionIdCache.values().next().value;
  if (firstInstId) {
    const { data: profile } = await db.rpc("get_student_knowledge_context", {
      p_student_id: user.id,
      p_institution_id: firstInstId,
    });
    if (profile) {
      sharedProfileContext = `\nPerfil del alumno: ${JSON.stringify(profile)}`;
    }
  }

  // ── Sequential generation loop (D15, D16) ──────────────────
  const generatedItems: BulkGeneratedItem[] = [];
  const bulkErrors: BulkErrorItem[] = [];
  let totalTokensInput = 0;
  let totalTokensOutput = 0;

  const systemPrompt =
    "Eres un tutor educativo adaptativo. Genera contenido " +
    "personalizado segun el nivel de dominio del alumno.\n" +
    "Responde SOLO con JSON valido, sin explicaciones adicionales.";

  for (const target of selectedTargets) {
    try {
      const pKnow = Number(target.p_know);
      const reasonText = reasonToText(target.primary_reason, pKnow);
      const contentSnippet = summaryContentCache.get(target.summary_id) || "";

      // Per-target: professor notes
      let profNotesContext = "";
      const { data: profNotes } = await db
        .from("kw_prof_notes")
        .select("note")
        .eq("keyword_id", target.keyword_id)
        .limit(3);

      if (profNotes && profNotes.length > 0) {
        profNotesContext =
          "\nNotas del profesor: " +
          profNotes.map((n: { note: string }) => n.note).join("; ");
      }

      // Per-target: BKT state
      let bktContext = "";
      if (target.subtopic_id) {
        const { data: bkt } = await db
          .from("bkt_states")
          .select("p_know, total_attempts, correct_attempts")
          .eq("student_id", user.id)
          .eq("subtopic_id", target.subtopic_id)
          .maybeSingle();
        if (bkt) {
          bktContext = `\nBKT del subtema: p_know=${bkt.p_know}, intentos=${bkt.total_attempts}, correctos=${bkt.correct_attempts}`;
        }
      }

      // Build prompt (same structure as single path)
      let userPrompt = "";

      if (action === "quiz_question") {
        userPrompt = `Genera UNA pregunta de quiz adaptada al nivel del alumno.

Seleccion automatica: ${reasonText}

Tema: ${target.summary_title}
Keyword: ${target.keyword_name}${target.keyword_def ? ` — ${target.keyword_def}` : ""}
${target.subtopic_name ? `Subtema: ${target.subtopic_name}` : ""}
${profNotesContext}
Contenido relevante: ${contentSnippet}
${sharedProfileContext}
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
        const scope = related
          ? `Genera una flashcard RELACIONADA al keyword "${target.keyword_name}".`
          : `Genera una flashcard GENERAL del resumen "${target.summary_title}".`;

        userPrompt = `${scope}

Seleccion automatica: ${reasonText}

Keyword: ${target.keyword_name}${target.keyword_def ? ` — ${target.keyword_def}` : ""}
${target.subtopic_name ? `Subtema: ${target.subtopic_name}` : ""}
${profNotesContext}
Contenido relevante: ${contentSnippet}
${sharedProfileContext}

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

      // Gemini call with adaptive temperature per target (D10)
      const result = await generateText({
        prompt: userPrompt,
        systemPrompt,
        jsonMode: true,
        temperature: adaptiveTemperature(pKnow),
        maxTokens: 1024,
      });

      const generated = parseGeminiJson(result.text);
      const g = generated as Record<string, unknown>;

      totalTokensInput += result.tokensUsed.input;
      totalTokensOutput += result.tokensUsed.output;

      // Insert into DB
      if (action === "quiz_question") {
        const { data: inserted, error: insertErr } = await db
          .from("quiz_questions")
          .insert({
            summary_id: target.summary_id,
            keyword_id: target.keyword_id,
            subtopic_id: target.subtopic_id,
            question_type: g.question_type || "multiple_choice",
            question: g.question,
            options: g.options || null,
            correct_answer: g.correct_answer,
            explanation: g.explanation || null,
            difficulty: g.difficulty || "medium",
            source: "ai",
            created_by: user.id,
            ...(quizId && { quiz_id: quizId }),
          })
          .select("id")
          .single();

        if (insertErr) {
          bulkErrors.push({
            keyword_id: target.keyword_id,
            keyword_name: target.keyword_name,
            error: `Insert failed: ${insertErr.message}`,
          });
          continue;
        }

        generatedItems.push({
          type: "quiz_question",
          id: inserted!.id as string,
          keyword_id: target.keyword_id,
          keyword_name: target.keyword_name,
          summary_id: target.summary_id,
          _smart: {
            p_know: pKnow,
            need_score: Number(target.need_score),
            primary_reason: target.primary_reason,
            target_subtopic: target.subtopic_name,
          },
        });
      } else {
        const { data: inserted, error: insertErr } = await db
          .from("flashcards")
          .insert({
            summary_id: target.summary_id,
            keyword_id: target.keyword_id,
            subtopic_id: target.subtopic_id,
            front: g.front,
            back: g.back,
            source: "ai",
            created_by: user.id,
          })
          .select("id")
          .single();

        if (insertErr) {
          bulkErrors.push({
            keyword_id: target.keyword_id,
            keyword_name: target.keyword_name,
            error: `Insert failed: ${insertErr.message}`,
          });
          continue;
        }

        generatedItems.push({
          type: "flashcard",
          id: inserted!.id as string,
          keyword_id: target.keyword_id,
          keyword_name: target.keyword_name,
          summary_id: target.summary_id,
          _smart: {
            p_know: pKnow,
            need_score: Number(target.need_score),
            primary_reason: target.primary_reason,
            target_subtopic: target.subtopic_name,
          },
        });
      }
    } catch (e) {
      // D16: Partial success — log error, continue with next target
      console.error(
        `[GenerateSmart Bulk] Failed for keyword ${target.keyword_name}:`,
        (e as Error).message,
      );
      bulkErrors.push({
        keyword_id: target.keyword_id,
        keyword_name: target.keyword_name,
        error: (e as Error).message,
      });
    }
  }

  // ── Bulk response (D16 partial-success pattern) ─────────────
  const status = generatedItems.length > 0
    ? 201
    : bulkErrors.length > 0
      ? 207
      : 200;

  return ok(
    c,
    {
      items: generatedItems,
      errors: bulkErrors,
      _meta: {
        model: GENERATE_MODEL,
        action,
        ...(summaryId && { summary_id: summaryId }),
        ...(quizId && { quiz_id: quizId }),
        total_attempted: selectedTargets.length,
        total_generated: generatedItems.length,
        total_failed: bulkErrors.length,
        total_targets_available: allTargets.length,
        tokens: {
          input: totalTokensInput,
          output: totalTokensOutput,
        },
      },
    },
    status,
  );
});
