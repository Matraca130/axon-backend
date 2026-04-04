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
 *   auto_create_quiz: boolean (optional, Fase 8G: server-side quiz creation)
 *   quiz_title: string (optional, Fase 8G: title for auto-created quiz)
 *
 * Unlike POST /ai/generate which requires the client to provide
 * summary_id + keyword_id, this endpoint AUTO-SELECTS the best
 * concept to study based on the student's BKT mastery profile.
 *
 * PR #103: Modularized — helpers/types in generate-smart-helpers.ts,
 *   prompt builders in generate-smart-prompts.ts.
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
 *   4. Sequential Claude calls per target (D15 pattern from pre-generate)
 *   5. Partial-success response (D16 pattern from pre-generate)
 *
 * Fase 8G: auto_create_quiz
 *   When auto_create_quiz=true, action=quiz_question, and summary_id is
 *   provided, the server creates a quiz entity before generating questions.
 *   This bypasses the CRUD factory's CONTENT_WRITE_ROLES check, allowing
 *   students to create adaptive quizzes without professor-level permissions.
 *
 * Dedup granularity (Fase 8F):
 *   - Primary: subtopic_id (most targets have one after v2 migration)
 *   - Fallback: keyword_id (for targets without subtopic_id)
 *
 * Architectural decisions: D1, D2, D3, D8, D10-D13
 * Error prevention: E1, E2, E7, E8, E9
 * Security: PF-05 (DB before Gemini), BUG-3 (institution scoping)
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { isUuid, isOneOf, isNonNegInt } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { generateText, parseClaudeJson, GENERATE_MODEL } from "../../claude-ai.ts";
import { normalizeDifficulty, normalizeQuestionType } from "../../ai-normalizers.ts";
import { sanitizeForPrompt } from "../../prompt-sanitize.ts";
import { validateQuizQuestion, validateFlashcard } from "../../lib/validate-llm-output.ts";
import { checkPlanLimit } from "../plans/access.ts";

// PR #103: Extracted modules
import type { SmartTarget, BulkGeneratedItem, BulkErrorItem } from "./generate-smart-helpers.ts";
import { ACTIONS, MAX_BULK_COUNT, truncateForPrompt, adaptiveTemperature } from "./generate-smart-helpers.ts";
import type { PromptContext } from "./generate-smart-prompts.ts";
import { SYSTEM_PROMPT, buildQuizPrompt, buildFlashcardPrompt } from "./generate-smart-prompts.ts";

export const aiGenerateSmartRoutes = new Hono();

// ── Dedup helper: subtopic if available, keyword fallback ─────
function isTargetDeduped(
  t: SmartTarget,
  recentSubtopicIds: Set<string>,
  recentKeywordIds: Set<string>,
): boolean {
  if (t.subtopic_id) return recentSubtopicIds.has(t.subtopic_id);
  return recentKeywordIds.has(t.keyword_id);
}

// ── Fetch per-target context (prof notes + BKT) ───────────────
async function fetchTargetContext(
  db: SupabaseClient,
  userId: string,
  target: SmartTarget,
): Promise<{ profNotesContext: string; bktContext: string }> {
  let profNotesContext = "";
  const { data: profNotes } = await db
    .from("kw_prof_notes")
    .select("note")
    .eq("keyword_id", target.keyword_id)
    .limit(3);

  if (profNotes && profNotes.length > 0) {
    const notesJoined = profNotes.map((n: { note: string }) => n.note).join("; ");
    profNotesContext = sanitizeForPrompt(notesJoined, 1000);
  }

  let bktContext = "";
  if (target.subtopic_id) {
    const { data: bkt } = await db
      .from("bkt_states")
      .select("p_know, total_attempts, correct_attempts")
      .eq("student_id", userId)
      .eq("subtopic_id", target.subtopic_id)
      .maybeSingle();
    if (bkt) {
      bktContext = `\nBKT del subtema: p_know=${bkt.p_know}, intentos=${bkt.total_attempts}, correctos=${bkt.correct_attempts}`;
    }
  }

  return { profNotesContext, bktContext };
}

// ── Build PromptContext from target + fetched data ────────────
function buildPromptContext(
  target: SmartTarget,
  contentSnippet: string,
  profNotesContext: string,
  profileContext: string,
  bktContext: string,
): PromptContext {
  return {
    summaryTitle: target.summary_title,
    keywordName: target.keyword_name,
    keywordDef: target.keyword_def,
    subtopicName: target.subtopic_name,
    primaryReason: target.primary_reason,
    pKnow: Number(target.p_know),
    contentSnippet,
    profNotesContext,
    profileContext,
    bktContext,
  };
}

// ── Generate + Insert single item ─────────────────────────────
async function generateAndInsert(
  db: SupabaseClient,
  userId: string,
  action: string,
  related: boolean,
  quizId: string | null,
  target: SmartTarget,
  ctx: PromptContext,
): Promise<{ data: Record<string, unknown>; tokensUsed: { input: number; output: number } }> {
  const pKnow = Number(target.p_know);
  const userPrompt = action === "quiz_question"
    ? buildQuizPrompt(ctx)
    : buildFlashcardPrompt(ctx, related);

  const result = await generateText({
    prompt: userPrompt,
    systemPrompt: SYSTEM_PROMPT,
    jsonMode: true,
    temperature: adaptiveTemperature(pKnow),
    maxTokens: 1024,
  });

  const generated = parseClaudeJson(result.text) as Record<string, unknown>;

  if (action === "quiz_question") {
    const questionType = normalizeQuestionType(generated.question_type);
    const validated = validateQuizQuestion(generated, questionType);  // AI-001 + AXO-126 FIX
    const { data: inserted, error: insertErr } = await db
      .from("quiz_questions")
      .insert({
        summary_id: target.summary_id,
        keyword_id: target.keyword_id,
        subtopic_id: target.subtopic_id,
        question_type: validated.question_type,
        question: validated.question,
        options: validated.options,
        correct_answer: validated.correct_answer,
        explanation: validated.explanation,
        difficulty: normalizeDifficulty(generated.difficulty),
        source: "ai",
        created_by: userId,
        ...(quizId && { quiz_id: quizId }),
      })
      .select()
      .single();

    if (insertErr) throw new Error(`Insert quiz_question failed: ${insertErr.message}`);
    return { data: inserted, tokensUsed: result.tokensUsed };
  } else {
    const validated = validateFlashcard(generated);  // AI-001 FIX: sanitize LLM output
    const { data: inserted, error: insertErr } = await db
      .from("flashcards")
      .insert({
        summary_id: target.summary_id,
        keyword_id: target.keyword_id,
        subtopic_id: target.subtopic_id,
        front: validated.front,
        back: validated.back,
        source: "ai",
        created_by: userId,
      })
      .select()
      .single();

    if (insertErr) throw new Error(`Insert flashcard failed: ${insertErr.message}`);
    return { data: inserted, tokensUsed: result.tokensUsed };
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN ROUTE HANDLER
// ══════════════════════════════════════════════════════════════

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

  const summaryId = isUuid(body.summary_id)
    ? (body.summary_id as string)
    : null;

  let count = 1;
  if (body.count !== undefined) {
    if (!isNonNegInt(body.count) || (body.count as number) < 1)
      return err(c, `count must be an integer between 1 and ${MAX_BULK_COUNT}`, 400);
    count = Math.min(body.count as number, MAX_BULK_COUNT);
  }

  let quizId = isUuid(body.quiz_id)
    ? (body.quiz_id as string)
    : null;

  // ── Fase 8G: Auto-create quiz entity server-side ─────────────
  const autoCreateQuiz = body.auto_create_quiz === true;

  if (autoCreateQuiz && !quizId && action === "quiz_question" && summaryId) {
    const quizTitle =
      typeof body.quiz_title === "string" && body.quiz_title.trim()
        ? body.quiz_title.trim()
        : `Quiz Adaptativo \u2014 ${new Date().toISOString().substring(0, 16).replace("T", " ")}`;

    const { data: newQuiz, error: quizCreateErr } = await db
      .from("quizzes")
      .insert({
        summary_id: summaryId,
        title: quizTitle,
        description: `Quiz generado por IA (${count} preguntas)`,
        source: "ai",
        created_by: user.id,
      })
      .select("id")
      .single();

    if (quizCreateErr) {
      console.error("[GenerateSmart] Auto-create quiz failed:", quizCreateErr.message);
      return safeErr(c, "Auto-create quiz", quizCreateErr);
    }

    quizId = newQuiz!.id as string;
    console.warn(`[GenerateSmart] Auto-created quiz ${quizId} for student ${user.id}`);
  }

  // ── Step 2: RPC get_smart_generate_target ───────────────────
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
    return safeErr(c, "Smart target selection", rpcError);
  }

  if (!targets || targets.length === 0) {
    const scopeMsg = summaryId
      ? "No keywords found for this summary."
      : "No study material available. Ensure you have an active membership " +
        "and your courses contain summaries with keywords.";
    return err(c, scopeMsg, 404);
  }

  // ── Step 3: Dedup check (Fase 8F: subtopic-level, 2h window) ─
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const dedupTable =
    action === "quiz_question" ? "quiz_questions" : "flashcards";

  const targetSubtopicIds = [...new Set(
    (targets as SmartTarget[])
      .map((t) => t.subtopic_id)
      .filter((id): id is string => id !== null),
  )];

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

  const checkDedup = (t: SmartTarget) =>
    isTargetDeduped(t, recentSubtopicIds, recentKeywordIds);

  // ══════════════════════════════════════════════════════════
  // SINGLE-ITEM PATH (count=1)
  // ══════════════════════════════════════════════════════════
  if (count === 1) {
    const chosen: SmartTarget =
      (targets as SmartTarget[]).find((t) => !checkDedup(t)) ??
      (targets[0] as SmartTarget);

    // Institution scoping (PF-05, BUG-3)
    const { data: resolvedInstId } = await db.rpc(
      "resolve_parent_institution",
      { p_table: "summaries", p_id: chosen.summary_id },
    );
    if (!resolvedInstId)
      return err(c, "Summary not found or inaccessible", 404);

    const roleCheck = await requireInstitutionRole(
      db, user.id, resolvedInstId as string, ALL_ROLES,
    );
    if (isDenied(roleCheck))
      return err(c, roleCheck.message, roleCheck.status);

    // ── Plan limit enforcement ──────────────────────────────
    const planCheck = await checkPlanLimit(db, user.id, resolvedInstId as string);
    if (!planCheck.allowed) {
      return err(c, `Daily AI generation limit reached (${planCheck.limit}). Upgrade your plan.`, 429);
    }

    // Fetch context
    const { data: summary } = await db
      .from("summaries")
      .select("content_markdown")
      .eq("id", chosen.summary_id)
      .single();

    const contentSnippet = truncateForPrompt(
      summary?.content_markdown || "", 1500,
    );

    const { profNotesContext, bktContext } = await fetchTargetContext(
      db, user.id, chosen,
    );

    let profileContext = "";
    const { data: profile } = await db.rpc("get_student_knowledge_context", {
      p_student_id: user.id,
      p_institution_id: resolvedInstId as string,
    });
    if (profile) {
      profileContext = `\nPerfil del alumno: ${JSON.stringify(profile)}`;
    }

    const ctx = buildPromptContext(
      chosen, contentSnippet, profNotesContext, profileContext, bktContext,
    );

    try {
      const { data: inserted, tokensUsed } = await generateAndInsert(
        db, user.id, action, related, quizId, chosen, ctx,
      );

      const pKnow = Number(chosen.p_know);
      return ok(
        c,
        {
          ...inserted,
          _meta: {
            model: GENERATE_MODEL,
            tokens: tokensUsed,
            ...(quizId && { quiz_id: quizId }),
          },
          _smart: {
            target_keyword: chosen.keyword_name,
            target_summary: chosen.summary_title,
            target_subtopic: chosen.subtopic_name,
            p_know: pKnow,
            need_score: Number(chosen.need_score),
            primary_reason: chosen.primary_reason,
            was_deduped: checkDedup(chosen),
            candidates_evaluated: (targets as SmartTarget[]).length,
          },
        },
        201,
      );
    } catch (e) {
      console.error("[GenerateSmart] Claude error:", e);
      return safeErr(c, "AI generation", e instanceof Error ? e : null);
    }
  }

  // ══════════════════════════════════════════════════════════
  // BULK PATH (count > 1) — Fase 8E
  // Sequential Claude calls with partial-success (D15, D16)
  // ══════════════════════════════════════════════════════════

  const allTargets = targets as SmartTarget[];
  const freshTargets = allTargets.filter((t) => !checkDedup(t));
  const selectedTargets = freshTargets.length >= count
    ? freshTargets.slice(0, count)
    : [
        ...freshTargets,
        ...allTargets
          .filter((t) => checkDedup(t))
          .slice(0, count - freshTargets.length),
      ];

  // Pre-fetch shared context
  const summaryContentCache = new Map<string, string>();
  const institutionIdCache = new Map<string, string>();
  const uniqueSummaryIds = [...new Set(selectedTargets.map((t) => t.summary_id))];

  for (const sid of uniqueSummaryIds) {
    // PF-05: Institution check BEFORE any Claude call
    const { data: instId } = await db.rpc("resolve_parent_institution", {
      p_table: "summaries", p_id: sid,
    });
    if (!instId) return err(c, `Summary ${sid} not found or inaccessible`, 404);

    const roleCheck = await requireInstitutionRole(
      db, user.id, instId as string, ALL_ROLES,
    );
    if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

    institutionIdCache.set(sid, instId as string);

    const { data: summaryData } = await db
      .from("summaries")
      .select("content_markdown")
      .eq("id", sid)
      .single();

    summaryContentCache.set(
      sid, truncateForPrompt(summaryData?.content_markdown || "", 1500),
    );
  }

  // ── Plan limit enforcement (bulk path) ──────────────────
  const firstInstIdForLimit = institutionIdCache.values().next().value;
  if (firstInstIdForLimit) {
    const planCheck = await checkPlanLimit(db, user.id, firstInstIdForLimit as string);
    if (!planCheck.allowed) {
      return err(c, `Daily AI generation limit reached (${planCheck.limit}). Upgrade your plan.`, 429);
    }
  }

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

  // Sequential generation loop (D15, D16)
  const generatedItems: BulkGeneratedItem[] = [];
  const bulkErrors: BulkErrorItem[] = [];
  let totalTokensInput = 0;
  let totalTokensOutput = 0;

  for (const target of selectedTargets) {
    try {
      const pKnow = Number(target.p_know);
      const contentSnippet = summaryContentCache.get(target.summary_id) || "";
      const { profNotesContext, bktContext } = await fetchTargetContext(
        db, user.id, target,
      );

      const ctx = buildPromptContext(
        target, contentSnippet, profNotesContext, sharedProfileContext, bktContext,
      );

      const { data: inserted, tokensUsed } = await generateAndInsert(
        db, user.id, action, related, quizId, target, ctx,
      );

      totalTokensInput += tokensUsed.input;
      totalTokensOutput += tokensUsed.output;

      generatedItems.push({
        type: action === "quiz_question" ? "quiz_question" : "flashcard",
        id: (inserted as Record<string, unknown>).id as string,
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
    } catch (e) {
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
