/**
 * routes/ai/generate.ts — Adaptive content generation via Gemini
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
import { generateText, parseGeminiJson } from "../../gemini.ts";

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

  // ── BUG-3 FIX: Institution scoping ───────────────────────
  // ⚠️ PF-05: This Supabase query MUST happen before the Gemini API call.
  // authenticate() only decodes the JWT locally. The cryptographic signature
  // is validated by PostgREST when this RPC executes. Moving the Gemini call
  // before this point would allow forged JWTs to consume API credits.
  const { data: instId } = await db.rpc("resolve_parent_institution", {
    p_table: "summaries",
    p_id: summaryId,
  });
  if (!instId) return err(c, "Summary not found", 404);
  const roleCheck = await requireInstitutionRole(
    db, user.id, instId as string, ALL_ROLES,
  );
  if (isDenied(roleCheck))
    return err(c, roleCheck.message, roleCheck.status);

  // ── Fetch summary ────────────────────────────────────────
  const { data: summary } = await db
    .from("summaries")
    .select("id, title, content_markdown, topic_id")
    .eq("id", summaryId)
    .single();
  if (!summary) return err(c, "Summary not found", 404);

  // ── BUG-4 FIX: Resolve keyword_id ───────────────────────
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

  // ── Fetch keyword + subtopic details ─────────────────────
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

  // ── Optional: scope to summary_block ─────────────────────
  let blockContext = "";
  if (blockId) {
    const { data: block } = await db
      .from("summary_blocks")
      .select("content, heading_text")
      .eq("id", blockId)
      .single();
    if (block) {
      blockContext = `\nBloque especifico: "${block.heading_text || ""}": ${block.content?.substring(0, 500)}`;
    }
  }

  // ── Fetch student profile ────────────────────────────────
  let profileContext = "";
  const { data: profile } = await db.rpc("get_student_knowledge_context", {
    p_student_id: user.id,
    p_institution_id: instId as string,
  });
  if (profile) {
    profileContext = `\nPerfil del alumno: ${JSON.stringify(profile)}`;
  }

  // ── Fetch BKT state for this subtopic ────────────────────
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

  // ── Build prompt ─────────────────────────────────────────
  const contentSnippet = (summary.content_markdown || "")
    .substring(0, 1500);

  const systemPrompt = `Eres un tutor educativo. Genera contenido adaptado al nivel del alumno.
Responde SOLO con JSON valido, sin explicaciones adicionales.`;

  let userPrompt = "";

  if (action === "quiz_question") {
    const wrongCtx = wrongAnswer
      ? `\nEl alumno respondio incorrectamente: "${wrongAnswer}". Genera una pregunta que aborde este error especifico, reformulando el concepto de otra manera.`
      : "";

    userPrompt = `Genera UNA pregunta de quiz sobre:
Tema: ${summary.title}
Keyword: ${keyword?.name || "general"} — ${keyword?.definition || ""}
${subtopicName ? `Subtema: ${subtopicName}` : ""}
${blockContext}
Contenido relevante: ${contentSnippet}
${profileContext}
${bktContext}
${wrongCtx}

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
      ? `Genera una flashcard RELACIONADA al keyword "${keyword?.name}".`
      : `Genera una flashcard GENERAL del resumen "${summary.title}".`;

    userPrompt = `${scope}
Keyword: ${keyword?.name || "general"} — ${keyword?.definition || ""}
${subtopicName ? `Subtema: ${subtopicName}` : ""}
${blockContext}
Contenido relevante: ${contentSnippet}
${profileContext}

Responde en JSON con este schema exacto:
{
  "front": "pregunta o concepto",
  "back": "respuesta o explicacion"
}`;
  }

  // ── Call Gemini ──────────────────────────────────────────
  try {
    const result = await generateText({
      prompt: userPrompt,
      systemPrompt,
      jsonMode: true,
      temperature: wrongAnswer ? 0.5 : 0.7,
      maxTokens: 1024,
    });

    const generated = parseGeminiJson(result.text);

    // ── Insert into DB ───────────────────────────────────
    if (action === "quiz_question") {
      const g = generated as Record<string, unknown>;
      const { data: inserted, error: insertErr } = await db
        .from("quiz_questions")
        .insert({
          summary_id: summaryId,
          keyword_id: keywordId,
          subtopic_id: subtopicId,
          question_type: g.question_type || "multiple_choice",
          question: g.question,
          options: g.options || null,
          correct_answer: g.correct_answer,
          explanation: g.explanation || null,
          difficulty: g.difficulty || "medium",
          source: "ai",
          created_by: user.id,  // BUG-1 FIX
        })
        .select()
        .single();

      if (insertErr)
        return err(c, `Insert quiz_question failed: ${insertErr.message}`, 500);

      return ok(c, {
        ...inserted,
        _meta: {
          model: "gemini-2.0-flash",
          tokens: result.tokensUsed,
          had_wrong_answer: !!wrongAnswer,
        },
      }, 201);
    } else {
      const g = generated as Record<string, unknown>;
      const { data: inserted, error: insertErr } = await db
        .from("flashcards")
        .insert({
          summary_id: summaryId,
          keyword_id: keywordId,
          subtopic_id: subtopicId,
          front: g.front,
          back: g.back,
          source: "ai",
          created_by: user.id,  // BUG-1 FIX
        })
        .select()
        .single();

      if (insertErr)
        return err(c, `Insert flashcard failed: ${insertErr.message}`, 500);

      return ok(c, {
        ...inserted,
        _meta: {
          model: "gemini-2.0-flash",
          tokens: result.tokensUsed,
          related,
        },
      }, 201);
    }
  } catch (e) {
    console.error("[AI Generate] Gemini error:", e);
    return err(c, `AI generation failed: ${(e as Error).message}`, 500);
  }
});
