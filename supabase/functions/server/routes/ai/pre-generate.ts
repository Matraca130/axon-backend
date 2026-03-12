/**
 * routes/ai/pre-generate.ts — Bulk AI content pre-generation (Fase 8D)
 *
 * POST /ai/pre-generate
 *   summary_id: UUID (required) — summary to generate content for
 *   action: "quiz_question" | "flashcard" (required)
 *   count: 1-5 (optional, default 3) — number of items to generate
 *
 * Purpose:
 *   Lets professors/admins proactively generate AI content for a summary.
 *   Instead of waiting for students to trigger generation one-by-one via
 *   /ai/generate or /ai/generate-smart, this endpoint fills coverage gaps
 *   by generating content for keywords that have the LEAST existing AI items.
 *
 * Key differences from /ai/generate and /ai/generate-smart:
 *   - /ai/generate: Student provides exact keyword_id → 1 item
 *   - /ai/generate-smart: System chooses keyword via NeedScore → 1 item
 *   - /ai/pre-generate: Professor bulk-fills gaps → up to 5 items
 *
 * Design decisions:
 *   D9:  Separate rate limit bucket (ai-pregen:{userId}, 10/hour).
 *        Uses the SAME check_rate_limit() RPC but with a different key.
 *        Skipped from the general AI middleware in index.ts.
 *        Rationale: pre-gen is a professor action, not a student action.
 *        It shouldn't consume the student's interactive AI budget.
 *   D14: CONTENT_WRITE_ROLES — only professors/admins can pre-generate.
 *        Students access AI content via /ai/generate or /ai/generate-smart.
 *   D15: Sequential Gemini calls, NOT parallel.
 *        Gemini has 15 RPM for generation. 5 parallel calls could spike.
 *        Sequential also gives cleaner partial-success error handling.
 *   D16: Partial-success response — if 3 of 5 succeed, return the 3
 *        successful items + 2 error entries. Never all-or-nothing.
 *   D17: No student profile in prompt. Pre-generated content is generic
 *        (available to ALL students). Including a specific student's
 *        p_know/BKT would bias the content toward one learner.
 *        Temperature is fixed at 0.7 (medium).
 *   D18: Keywords selected by ascending AI content count — fills gaps
 *        first. If keyword A has 0 AI quiz_questions and keyword B has 3,
 *        keyword A is generated first.
 *
 * Security:
 *   PF-05: DB query (resolve institution + role check) BEFORE Gemini call.
 *   BUG-1: created_by = user.id on all inserts.
 *   BUG-3: Institution scoping via resolve_parent_institution().
 *
 * Normalization fixes applied:
 *   NORM-1 FIX: normalizeDifficulty() + normalizeQuestionType() from shared ai-normalizers.ts
 *
 * Rate limit architecture:
 *   index.ts middleware → skips /ai/pre-generate (like /ai/report)
 *   This endpoint → calls check_rate_limit() internally with its own key.
 *   Budget: 10 requests/hour × 5 items/request = max 50 Gemini calls/hour.
 *
 * SECURITY FIX (Gemini Code Assist review):
 *   Rate limiter changed from fail-open to FAIL-CLOSED.
 *   If check_rate_limit() RPC fails, the request is DENIED (500)
 *   instead of allowed through. This prevents uncontrolled Gemini
 *   API usage and unexpected costs when the DB is unreachable.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX, getAdminClient } from "../../db.ts";
import { isUuid, isOneOf, isNonNegInt } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import { generateText, parseGeminiJson, GENERATE_MODEL } from "../../gemini.ts";
import { normalizeDifficulty, normalizeQuestionType } from "../../ai-normalizers.ts";

export const aiPreGenerateRoutes = new Hono();

// ── Constants ─────────────────────────────────────────────
const ACTIONS = ["quiz_question", "flashcard"] as const;
const MAX_COUNT = 5;     // Max items per request
const DEFAULT_COUNT = 3; // Default items if count not provided

// D9: Separate rate limit bucket for pre-generation
const PREGEN_RATE_LIMIT = 10;           // max requests per window
const PREGEN_RATE_WINDOW_MS = 3_600_000; // 1 hour

// ── D12: Local truncateAtWord (same as generate-smart.ts) ─────
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.substring(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > maxLen * 0.8
    ? truncated.substring(0, lastSpace) + "..."
    : truncated + "...";
}

// ── Types ────────────────────────────────────────────────
interface GeneratedItem {
  type: string;
  id: string;
  keyword_id: string;
  keyword_name: string;
}

interface GenerationError {
  keyword_id: string;
  keyword_name: string;
  error: string;
}

// ================================================================
// POST /ai/pre-generate — Bulk AI content pre-generation
// ================================================================

aiPreGenerateRoutes.post(
  `${PREFIX}/ai/pre-generate`,
  async (c: Context) => {
    // ── Step 1: Auth (PF-05: JWT before any operation) ────────
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    // ── Step 2: Validate body ───────────────────────────────
    const body = await safeJson(c);
    if (!body) return err(c, "Invalid JSON body", 400);

    if (!isUuid(body.summary_id))
      return err(c, "summary_id is required (UUID)", 400);
    const summaryId = body.summary_id as string;

    const action = body.action as string;
    if (!isOneOf(action, ACTIONS))
      return err(c, "action must be 'quiz_question' or 'flashcard'", 400);

    // Parse count: default 3, min 1, max 5
    let count = DEFAULT_COUNT;
    if (body.count !== undefined) {
      if (!isNonNegInt(body.count) || (body.count as number) < 1)
        return err(c, `count must be an integer between 1 and ${MAX_COUNT}`, 400);
      count = Math.min(body.count as number, MAX_COUNT);
    }

    // ── Step 3: Institution scoping (PF-05, BUG-3) ───────────
    // This DB call MUST happen before any Gemini call.
    // authenticate() only decodes JWT locally; PostgREST validates
    // the cryptographic signature when this RPC executes.
    const { data: institutionId } = await db.rpc(
      "resolve_parent_institution",
      { p_table: "summaries", p_id: summaryId },
    );
    if (!institutionId)
      return err(c, "Summary not found or inaccessible", 404);

    // D14: Only professors/admins can pre-generate
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      institutionId as string,
      CONTENT_WRITE_ROLES,
    );
    if (isDenied(roleCheck))
      return err(c, roleCheck.message, roleCheck.status);

    // ── Step 4: Pre-gen rate limit (D9: separate bucket) ──────
    // Uses the SAME check_rate_limit() RPC but with a different key.
    // adminClient required because rate_limit_entries may have RLS.
    //
    // SECURITY: Fail-closed — if rate limit check fails, DENY request.
    // This prevents uncontrolled Gemini API usage when DB is unreachable.
    try {
      const adminDb = getAdminClient();
      const { data: rlData, error: rlError } = await adminDb.rpc(
        "check_rate_limit",
        {
          p_key: `ai-pregen:${user.id}`,
          p_max_requests: PREGEN_RATE_LIMIT,
          p_window_ms: PREGEN_RATE_WINDOW_MS,
        },
      );

      if (rlError) {
        // Fail-closed: if rate limit check fails, deny the request.
        console.error(
          `[PreGenerate] Rate limit RPC failed: ${rlError.message}. Denying request.`,
        );
        return err(c, "Could not verify rate limit status. Please try again later.", 500);
      } else if (rlData && !rlData.allowed) {
        return err(
          c,
          `Pre-generation rate limit exceeded: max ${PREGEN_RATE_LIMIT} requests per hour. ` +
            `Try again in ${Math.ceil((rlData.retry_after_ms || 0) / 1000)}s.`,
          429,
        );
      }
    } catch (e) {
      // Fail-closed: unexpected exception → deny request.
      console.error(
        `[PreGenerate] Rate limit exception: ${(e as Error).message}. Denying request.`,
      );
      return err(c, "Could not verify rate limit status. Please try again later.", 500);
    }

    // ── Step 5: Fetch summary content (shared across all items) ──
    const { data: summary } = await db
      .from("summaries")
      .select("title, content_markdown")
      .eq("id", summaryId)
      .single();

    if (!summary)
      return err(c, "Summary not found", 404);

    const contentSnippet = truncateAtWord(
      summary.content_markdown || "",
      1500,
    );

    // ── Step 6: Fetch keywords + sort by least AI coverage (D18) ─
    const { data: keywords, error: kwError } = await db
      .from("keywords")
      .select("id, name, definition")
      .eq("summary_id", summaryId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (kwError || !keywords || keywords.length === 0)
      return err(
        c,
        "No keywords found for this summary. Add keywords before pre-generating.",
        400,
      );

    // Count existing AI content per keyword for this action type
    const dedupTable =
      action === "quiz_question" ? "quiz_questions" : "flashcards";

    const { data: existingContent } = await db
      .from(dedupTable)
      .select("keyword_id")
      .eq("summary_id", summaryId)
      .eq("source", "ai");

    // D18: Build coverage map and sort keywords by ascending count
    const coverageCounts = new Map<string, number>();
    for (const item of existingContent || []) {
      const kwId = item.keyword_id as string;
      coverageCounts.set(kwId, (coverageCounts.get(kwId) || 0) + 1);
    }

    const sortedKeywords = keywords
      .map((kw) => ({
        ...kw,
        existingCount: coverageCounts.get(kw.id as string) || 0,
      }))
      .sort((a, b) => a.existingCount - b.existingCount);

    // Take top `count` keywords (those with least coverage)
    const targetKeywords = sortedKeywords.slice(0, count);

    // ── Step 7: Sequential generation loop (D15, D16) ─────────
    const generated: GeneratedItem[] = [];
    const errors: GenerationError[] = [];
    let totalTokensInput = 0;
    let totalTokensOutput = 0;

    const systemPrompt =
      "Eres un tutor educativo. Genera contenido de estudio de calidad.\n" +
      "Responde SOLO con JSON valido, sin explicaciones adicionales.";

    for (const kw of targetKeywords) {
      try {
        // 7a. Fetch professor notes for this keyword (INC-6 pattern)
        let profNotesContext = "";
        const { data: profNotes } = await db
          .from("kw_prof_notes")
          .select("note")
          .eq("keyword_id", kw.id)
          .limit(3);

        if (profNotes && profNotes.length > 0) {
          profNotesContext =
            "\nNotas del profesor: " +
            profNotes.map((n: { note: string }) => n.note).join("; ");
        }

        // 7b. Build prompt (D17: no student profile, generic content)
        let userPrompt = "";

        if (action === "quiz_question") {
          userPrompt = `Genera UNA pregunta de quiz sobre:
Tema: ${summary.title}
Keyword: ${kw.name}${kw.definition ? ` \u2014 ${kw.definition}` : ""}
${profNotesContext}
Contenido relevante: ${contentSnippet}

Genera una pregunta de dificultad media, clara y educativa.

Responde en JSON con este schema exacto:
{
  "question_type": "mcq",
  "question": "texto de la pregunta",
  "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
  "correct_answer": "A",
  "explanation": "por que es correcta",
  "difficulty": 2
}
Nota: question_type debe ser "mcq", "true_false", "fill_blank" o "open".
Nota: difficulty debe ser un entero: 1 (facil), 2 (medio), 3 (dificil).`;
        } else {
          userPrompt = `Genera una flashcard sobre el keyword "${kw.name}".

Tema: ${summary.title}
Keyword: ${kw.name}${kw.definition ? ` \u2014 ${kw.definition}` : ""}
${profNotesContext}
Contenido relevante: ${contentSnippet}

Genera una flashcard clara y educativa.

Responde en JSON con este schema exacto:
{
  "front": "pregunta o concepto",
  "back": "respuesta o explicacion"
}`;
        }

        // 7c. Call Gemini (D15: sequential, D17: fixed temperature)
        const result = await generateText({
          prompt: userPrompt,
          systemPrompt,
          jsonMode: true,
          temperature: 0.7,
          maxTokens: 1024,
        });

        const parsed = parseGeminiJson(result.text);
        const g = parsed as Record<string, unknown>;

        totalTokensInput += result.tokensUsed.input;
        totalTokensOutput += result.tokensUsed.output;

        // 7d. Insert into DB (BUG-1: created_by = user.id)
        // NORM-1 FIX: Use shared normalizers for type safety
        if (action === "quiz_question") {
          const { data: inserted, error: insertErr } = await db
            .from("quiz_questions")
            .insert({
              summary_id: summaryId,
              keyword_id: kw.id,
              question_type: normalizeQuestionType(g.question_type),
              question: g.question,
              options: g.options || null,
              correct_answer: g.correct_answer,
              explanation: g.explanation || null,
              difficulty: normalizeDifficulty(g.difficulty),
              source: "ai",
              created_by: user.id,
            })
            .select("id")
            .single();

          if (insertErr) {
            errors.push({
              keyword_id: kw.id as string,
              keyword_name: kw.name as string,
              error: `Insert failed: ${insertErr.message}`,
            });
            continue;
          }

          generated.push({
            type: "quiz_question",
            id: inserted!.id as string,
            keyword_id: kw.id as string,
            keyword_name: kw.name as string,
          });
        } else {
          const { data: inserted, error: insertErr } = await db
            .from("flashcards")
            .insert({
              summary_id: summaryId,
              keyword_id: kw.id,
              front: g.front,
              back: g.back,
              source: "ai",
              created_by: user.id,
            })
            .select("id")
            .single();

          if (insertErr) {
            errors.push({
              keyword_id: kw.id as string,
              keyword_name: kw.name as string,
              error: `Insert failed: ${insertErr.message}`,
            });
            continue;
          }

          generated.push({
            type: "flashcard",
            id: inserted!.id as string,
            keyword_id: kw.id as string,
            keyword_name: kw.name as string,
          });
        }
      } catch (e) {
        // D16: Partial success — log error, continue with next keyword
        console.error(
          `[PreGenerate] Failed for keyword ${kw.name}:`,
          (e as Error).message,
        );
        errors.push({
          keyword_id: kw.id as string,
          keyword_name: kw.name as string,
          error: (e as Error).message,
        });
      }
    }

    // ── Step 8: Return partial-success response (D16) ──────────
    // Always 200 if at least 1 succeeded or 0 were attempted.
    // The _meta block tells the caller exactly what happened.
    const status = generated.length > 0 ? 201 : errors.length > 0 ? 207 : 200;

    return ok(
      c,
      {
        generated,
        errors,
        _meta: {
          model: GENERATE_MODEL,
          summary_id: summaryId,
          summary_title: summary.title,
          action,
          total_attempted: targetKeywords.length,
          total_generated: generated.length,
          total_failed: errors.length,
          total_keywords_in_summary: keywords.length,
          tokens: {
            input: totalTokensInput,
            output: totalTokensOutput,
          },
        },
      },
      status,
    );
  },
);
