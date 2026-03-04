/**
 * routes/ai/chat.ts — RAG Chat with adaptive context
 *
 * POST /ai/rag-chat
 *   message: string (required, max 2000 chars)
 *   summary_id: UUID (optional, scope search to one summary)
 *   history: Array<{role, content}> (optional, conversation history, max 6)
 *
 * Pipeline:
 *   1. Resolve institution (from summary or user's memberships)
 *   2. Embed the user's query via gemini-embedding-001 (768 dims)
 *   3. Hybrid search: pgvector cosine + full-text via rag_hybrid_search() RPC
 *   4. Fetch student knowledge profile via get_student_knowledge_context() RPC
 *   5. Generate response via Gemini 2.5 Flash with RAG context
 *
 * Pre-flight fixes applied:
 *   PF-01 FIX: Changed 'institution_members' → 'memberships' + is_active filter
 *   PF-05 FIX: DB queries happen before Gemini calls (JWT validation)
 *
 * Live-audit fixes applied:
 *   LA-03 FIX: Message length validation (max 2000 chars) + history truncation
 *
 * Coherence fixes applied:
 *   INC-1 FIX: Corrected stale model names in header comments
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { generateText, generateEmbedding } from "../../gemini.ts";

export const aiChatRoutes = new Hono();

aiChatRoutes.post(`${PREFIX}/ai/rag-chat`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body?.message || typeof body.message !== "string")
    return err(c, "message is required (string)", 400);

  // ── LA-03 FIX: Validate message length ──────────────────────
  const message = (body.message as string).trim();
  if (message.length === 0)
    return err(c, "message cannot be empty", 400);
  if (message.length > 2000)
    return err(c, "message too long (max 2000 characters)", 400);

  const summaryId = isUuid(body.summary_id) ? (body.summary_id as string) : null;

  // ── LA-03 FIX: Truncate each history entry to 500 chars ─────
  const history = Array.isArray(body.history)
    ? body.history.slice(-6).map((h: Record<string, string>) => ({
        role: h.role,
        content: typeof h.content === "string" ? h.content.slice(0, 500) : "",
      }))
    : [];

  // ── Resolve institution ──────────────────────────────────
  // ⚠️ PF-05: These DB queries validate the JWT cryptographically.
  // They MUST happen before any Gemini API call.
  let institutionId: string | null = null;
  if (summaryId) {
    const { data: instId } = await db.rpc("resolve_parent_institution", {
      p_table: "summaries",
      p_id: summaryId,
    });
    institutionId = instId as string;
  }
  if (!institutionId) {
    // PF-01 FIX: Use 'memberships' table (not 'institution_members' which doesn't exist)
    // Also filter by is_active = true, matching the pattern used everywhere in the backend
    const { data: membership } = await db
      .from("memberships")
      .select("institution_id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .limit(1)
      .single();
    institutionId = membership?.institution_id || null;
  }
  if (!institutionId)
    return err(c, "Could not resolve institution. User has no active memberships.", 400);

  // Verify membership
  const roleCheck = await requireInstitutionRole(
    db, user.id, institutionId, ALL_ROLES,
  );
  if (isDenied(roleCheck))
    return err(c, roleCheck.message, roleCheck.status);

  // ── RAG: embed query and search ──────────────────────────
  let ragContext = "";
  let sourcesUsed: Array<{ chunk_id: string; summary_title: string; similarity: number }> = [];

  try {
    const queryEmbedding = await generateEmbedding(message, "RETRIEVAL_QUERY");

    const { data: matches } = await db.rpc("rag_hybrid_search", {
      p_query_embedding: JSON.stringify(queryEmbedding),
      p_query_text: message,
      p_institution_id: institutionId,
      p_summary_id: summaryId || null,
      p_match_count: 5,
      p_similarity_threshold: 0.3,
    });

    if (matches && matches.length > 0) {
      ragContext = "\n\nContexto relevante del material de estudio:\n" +
        matches.map((m: Record<string, unknown>, i: number) =>
          `[${i + 1}] (de "${m.summary_title}"): ${m.content}`
        ).join("\n\n");

      sourcesUsed = matches.map((m: Record<string, unknown>) => ({
        chunk_id: m.chunk_id as string,
        summary_title: m.summary_title as string,
        similarity: Math.round((m.similarity as number) * 100) / 100,
      }));
    }
  } catch (e) {
    console.warn("[RAG Chat] Search failed, continuing without context:", e);
  }

  // ── Fetch student profile ────────────────────────────────
  let profileContext = "";
  try {
    const { data: profile } = await db.rpc("get_student_knowledge_context", {
      p_student_id: user.id,
      p_institution_id: institutionId,
    });
    if (profile) {
      profileContext = `\nPerfil del alumno (adapta tu respuesta a su nivel): ${JSON.stringify(profile)}`;
    }
  } catch {
    // Profile not available, continue without it
  }

  // ── Build conversation ───────────────────────────────────
  const systemPrompt = `Eres un tutor educativo amable y preciso.
Responde basandote en el contexto proporcionado del material de estudio.
Si no tienes informacion suficiente, dilo honestamente.
Adapta la complejidad de tu respuesta al nivel del alumno.
Responde en espanol.${profileContext}`;

  const conversationHistory = history
    .map((h: Record<string, string>) => `${h.role === "user" ? "Alumno" : "Tutor"}: ${h.content}`)
    .join("\n");

  const userPrompt = `${conversationHistory ? `Conversacion previa:\n${conversationHistory}\n\n` : ""}Alumno: ${message}${ragContext}`;

  // ── Generate response ────────────────────────────────────
  try {
    const result = await generateText({
      prompt: userPrompt,
      systemPrompt,
      temperature: 0.5,
      maxTokens: 1500,
    });

    return ok(c, {
      response: result.text,
      sources: sourcesUsed,
      tokens: result.tokensUsed,
      profile_used: !!profileContext,
    });
  } catch (e) {
    console.error("[RAG Chat] Gemini error:", e);
    return err(c, `Chat failed: ${(e as Error).message}`, 500);
  }
});
