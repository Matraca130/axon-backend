/**
 * routes/ai/generate.ts — Adaptive content generation via Claude
 *
 * POST /ai/generate
 *   action: "quiz_question" | "flashcard"
 *   summary_id: UUID (required)
 *   keyword_id: UUID (optional, resolved if missing)
 *   subtopic_id: UUID (optional)
 *   block_id: UUID (optional, scope to summary_block)
 *   wrong_answer: string (optional, for retry-on-error)
 *   related: boolean (default true, for flashcards)
 *
 * Pre-flight fixes applied:
 *   BUG-1 FIX: includes created_by: user.id
 *   BUG-3 FIX: explicit institution scoping via resolve_parent_institution()
 *   BUG-4 FIX: keyword_id fallback from summary's first keyword
 *   PF-05 FIX: Security comment about DB query before Gemini call
 *
 * Live-audit fixes applied:
 *   LA-07 FIX: truncateForPrompt() respects word boundaries
 *
 * Deploy fixes:
 *   D-18 FIX: Use GENERATE_MODEL constant in _meta (was hardcoded as gemini-2.0-flash)
 *
 * Coherence fixes applied:
 *   INC-6 FIX: Include kw_prof_notes in prompt for better pedagogical quality
 *
 * Normalization fixes applied:
 *   NORM-1 FIX: normalizeDifficulty() + normalizeQuestionType() from shared ai-normalizers.ts
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid, isOneOf } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { generateText, parseClaudeJson, GENERATE_MODEL } from "../../claude-ai.ts";
import { normalizeDifficulty, normalizeQuestionType } from "../../ai-normalizers.ts";
import { sanitizeForPrompt, sanitizeProfileForPrompt, wrapXml } from "../../prompt-sanitize.ts";
import { truncateForPrompt } from "./generate-smart-helpers.ts";
import { validateQuizQuestion, validateFlashcard } from "../../lib/validate-llm-output.ts";
import { checkPlanLimit } from "../plans/access.ts";
import { resolveInstitutionViaRpc } from "../../lib/institution-resolver.ts";

export const aiGenerateRoutes = new Hono();

const ACTIONS = ["quiz_question", "flashcard"] as const;

aiGenerateRoutes.post(`${PREFIX}/ai/generate`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  const action = body.action as string;
  if (!isOneOf(action, ACTIONS))
    return err(c, "action must be 'quiz_question' or 'flashcard'", 400);
  if (!isUuid(body.summary_id))
    return err(c, "summary_id is required (UUID)", 400);

  const summaryId = body.summary_id as string;
  const subtopicId = isUuid(body.subtopic_id) ? (body.subtopic_id as string) : null;
  const blockId = isUuid(body.block_id) ? (body.block_id as string) : null;
  const wrongAnswer = typeof body.wrong_answer === "string"
    ? body.wrong_answer : null;
  const related = body.related !== false;

  // ── BUG-3 FIX: Institution scoping ─────────────────────
  // \u26a0\ufe0f PF-05: This Supabase query MUST happen before the Gemini API call.
  // authenticate() only decodes the JWT locally. The cryptographic signature
  // is validated by PostgREST when this RPC executes. Moving the Gemini call
  // before this point would allow forged JWTs to consume API credits.
  const instId = await resolveInstitutionViaRpc(db, "summaries", summaryId);
  if (!instId) return err(c, "Summary not found", 404);
  const roleCheck = await requireInstitutionRole(
    db, user.id, instId, ALL_ROLES,
  );
  if (isDenied(roleCheck))
    return err(c, roleCheck.message, roleCheck.status);

  // ── Plan limit enforcement ──────────────────────────────
  const planCheck = await checkPlanLimit(db, user.id, instId);
  if (!planCheck.allowed) {
    return err(c, `Daily AI generation limit reached (${planCheck.limit}). Upgrade your plan.`, 429);
  }

  // ── Fetch summary ──────────────────────────────────────
  const { data: summary } = await db
    .from("summaries")
    .select("id, title, content_markdown, topic_id")
    .eq("id", summaryId)
    .single();
  if (!summary) return err(c, "Summary not found", 404);

  // ── BUG-4 FIX: Resolve keyword_id ─────────────────────
  let keywordId = isUuid(body.keyword_id) ? (body.keyword_id as string) : null;
  if (!keywordId) {
    const { data: kws } = await db
      .from("keywords")
      .select("id")
      .eq("summary_id", summaryId)
      .is("deleted_at", null)
      .limit(1);
    keywordId = kws?.[0]?.id || null;
  }
  if (!keywordId)
    return err(c, "No keywords found for this summary", 400);

  // ── Fetch keyword + subtopic details ───────────────────
  const { data: keyword } = await db
    .from("keywords")
    .select("name, definition")
    .eq("id", keywordId)
    .single();

  let subtopicName: string | null = null;
  if (subtopicId) {
    const { data: sub } = await db
      .from("subtopics")
      .select("name")
      .eq("id", subtopicId)
      .single();
    subtopicName = sub?.name || null;
  }

  // ── Optional: scope to summary_block ───────────────────
  let blockContext = "";
  if (blockId) {
    const { data: block } = await db
      .from("summary_blocks")
      .select("content, heading_text")
      .eq("id", blockId)
      .single();
    if (block) {
      blockContext = `\n${wrapXml('block_context', sanitizeForPrompt(`${block.heading_text || ""}: ${block.content || ""}`, 500))}`;
    }
  }

  // ── INC-6 FIX: Fetch professor notes for this keyword ──────
  // Quick fix from RAG_ROADMAP.md Fase 8C: include kw_prof_notes
  // in the prompt so generated content reflects professor guidance.
  const { data: profNotes } = await db
    .from("kw_prof_notes")
    .select("note")
    .eq("keyword_id", keywordId)
    .limit(3);

  if (profNotes && profNotes.length > 0) {
    const notesJoined = profNotes.map((n: { note: string }) => n.note).join("; ");
    blockContext += `\n${wrapXml('professor_notes', sanitizeForPrompt(notesJoined, 1000))}`;
  }

  // ── Fetch student profile ────────────────────────────────
  let profileContext = "";
  // SEC-S9B: Use admin client for SECURITY DEFINER RPCs
  const { data: profile } = await getAdminClient().rpc("get_student_knowledge_context", {
    p_student_id: user.id,
    p_institution_id: instId,
  });
  if (profile) {
    profileContext = `\nPerfil del alumno: ${JSON.stringify(sanitizeProfileForPrompt(profile))}`;
  }

  // ── Fetch BKT state for this subtopic ──────────────────
  let bktContext = "";
  if (subtopicId) {
    const { data: bkt } = await db
      .from("bkt_states")
      .select("p_know, total_attempts, correct_attempts")
      .eq("student_id", user.id)
      .eq("subtopic_id", subtopicId)
      .maybeSingle();
    if (bkt) {
      bktContext = `\nBKT del subtema: p_know=${bkt.p_know}, intentos=${bkt.total_attempts}, correctos=${bkt.correct_attempts}`;
    }
  }

  // ── Build prompt ───────────────────────────────────────
  // LA-07 FIX: Use truncateAtWord instead of raw substring
  const contentSnippet = truncateForPrompt(
    summary.content_markdown || "",
    1500,
  );

  const systemPrompt = `Eres un tutor educativo. Genera contenido adaptado al nivel del alumno.
Responde SOLO con JSON valido, sin explicaciones adicionales.`;

  let userPrompt = "";

  if (action === "quiz_question") {
    const wrongCtx = wrongAnswer
      ? `\nEl alumno respondio incorrectamente: ${wrapXml("student_answer", sanitizeForPrompt(wrongAnswer, 300))}. Genera una pregunta que aborde este error especifico, reformulando el concepto de otra manera.`
      : "";

    userPrompt = `Genera UNA pregunta de quiz sobre:
Tema: ${summary.title}
Keyword: ${sanitizeForPrompt(keyword?.name || "general", 200)} \u2014 ${keyword?.definition ? sanitizeForPrompt(keyword.definition, 500) : ""}
${subtopicName ? `Subtema: ${subtopicName}` : ""}
${blockContext}
${wrapXml("course_content", contentSnippet)}
${profileContext}
${bktContext}
${wrongCtx}

Responde en JSON con este schema exacto:
{
  "question_type": "mcq",
  "question": "texto de la pregunta",
  "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
  "correct_answer": "A",
  "explanation": "por que es correcta",
  "difficulty": 1
}
Nota: question_type debe ser "mcq", "true_false", "fill_blank" o "open".
Nota: difficulty debe ser un entero: 1 (facil), 2 (medio), 3 (dificil).`;
  } else {
    // flashcard
    const scope = related
      ? `Genera una flashcard RELACIONADA al keyword "${sanitizeForPrompt(keyword?.name || "general", 200)}".`
      : `Genera una flashcard GENERAL del resumen "${summary.title}".`;

    userPrompt = `${scope}
Keyword: ${sanitizeForPrompt(keyword?.name || "general", 200)} \u2014 ${keyword?.definition ? sanitizeForPrompt(keyword.definition, 500) : ""}
${subtopicName ? `Subtema: ${subtopicName}` : ""}
${blockContext}
${wrapXml("course_content", contentSnippet)}
${profileContext}

Responde en JSON con este schema exacto:
{
  "front": "pregunta o concepto",
  "back": "respuesta o explicacion"
}`;
  }

  // ── Call Claude ─────────────────────────────────────────
  try {
    const result = await generateText({
      prompt: userPrompt,
      systemPrompt,
      jsonMode: true,
      temperature: wrongAnswer ? 0.5 : 0.7,
      maxTokens: 1024,
    });

    const generated = parseClaudeJson(result.text);

    // ── Insert into DB ───────────────────────────────────
    if (action === "quiz_question") {
      const g = generated as Record<string, unknown>;
      const questionType = normalizeQuestionType(g.question_type);
      const validated = validateQuizQuestion(g, questionType);  // AI-001 + AXO-126 FIX
      const { data: inserted, error: insertErr } = await db
        .from("quiz_questions")
        .insert({
          summary_id: summaryId,
          keyword_id: keywordId,
          subtopic_id: subtopicId,
          block_id: blockId,
          question_type: validated.question_type,
          question: validated.question,
          options: validated.options,
          correct_answer: validated.correct_answer,
          explanation: validated.explanation,
          difficulty: normalizeDifficulty(g.difficulty),
          source: "ai",
          created_by: user.id,  // BUG-1 FIX
        })
        .select()
        .single();

      if (insertErr)
        return safeErr(c, "Insert quiz_question", insertErr);

      return ok(c, {
        ...inserted,
        _meta: {
          model: GENERATE_MODEL,  // D-18 FIX: use constant instead of hardcoded string
          tokens: result.tokensUsed,
          had_wrong_answer: !!wrongAnswer,
        },
      }, 201);
    } else {
      const g = generated as Record<string, unknown>;
      const validated = validateFlashcard(g);  // AI-001 FIX: sanitize LLM output
      const { data: inserted, error: insertErr } = await db
        .from("flashcards")
        .insert({
          summary_id: summaryId,
          keyword_id: keywordId,
          subtopic_id: subtopicId,
          front: validated.front,
          back: validated.back,
          source: "ai",
          created_by: user.id,  // BUG-1 FIX
        })
        .select()
        .single();

      if (insertErr)
        return safeErr(c, "Insert flashcard", insertErr);

      return ok(c, {
        ...inserted,
        _meta: {
          model: GENERATE_MODEL,  // D-18 FIX: use constant instead of hardcoded string
          tokens: result.tokensUsed,
          related,
        },
      }, 201);
    }
  } catch (e) {
    console.error("[AI Generate] Claude error:", e);
    return safeErr(c, "AI generation", e instanceof Error ? e : null);
  }
});
