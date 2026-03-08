/**
 * routes/ai/chat.ts — RAG Chat with adaptive context
 *
 * POST /ai/rag-chat
 *   message: string (required, max 2000 chars)
 *   summary_id: UUID (optional, scope search to one summary)
 *   history: Array<{role, content}> (optional, conversation history, max 6)
 *   strategy: string (optional, Fase 6: auto|standard|multi_query|hyde)
 *
 * Pipeline:
 *   1. Resolve institution (from summary or user's memberships)
 *   2. Build augmented query from message + history (Phase 5)
 *   3. Select retrieval strategy (Fase 6: auto/standard/multi_query/hyde)
 *   4. Execute strategy-specific embedding(s) (Fase 6)
 *   5. Search per embedding (hybrid or coarse-to-fine) + merge results
 *   6. Re-rank merged results via Gemini-as-Judge (Fase 6)
 *   7. Fetch adjacent chunks for context expansion (Phase 5)
 *   8. Fetch student knowledge profile via get_student_knowledge_context() RPC
 *   9. Generate response via Gemini 2.5 Flash with RAG context
 *   10. Log query metrics to rag_query_log (fire-and-forget)
 *
 * Phase 5 additions:
 *   - History-augmented search: uses last 2 user messages to improve follow-up recall
 *   - Adjacent chunk expansion: fetches ±1 order_index chunks for better context
 *   - Smart context assembly: orders by summary→order_index, deduplicates
 *
 * Fase 3 additions:
 *   - Coarse-to-fine search: two-level vector search (summary → chunk)
 *   - normalizeCoarseToFineResults(): adapter for MatchedChunk compatibility
 *   - Fallback chain: coarse-to-fine → hybrid (unscoped) → empty context
 *   - search_type logging: hybrid | coarse_to_fine | hybrid_fallback (+ _augmented)
 *
 * Fase 6 additions:
 *   - Strategy selection: selectStrategy() or client override via body.strategy
 *   - Multi-Query: Gemini reformulates query → 3 embeddings → merge results
 *   - HyDE: Gemini generates hypothetical answer → embed hypothesis
 *   - Re-ranking: Gemini scores chunk relevance, blends with original score
 *   - New log columns: retrieval_strategy, rerank_applied
 *   - Response _search metadata extended with strategy info
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
 *
 * Fase 4 additions:
 *   T-03: Query logging with latency, similarity metrics, and log_id for feedback
 *
 * SEC-01 FIX:
 *   SECURITY: Changed SECURITY DEFINER RPC calls (rag_hybrid_search,
 *   rag_coarse_to_fine_search) from user client (db) to admin client
 *   (getAdminClient()) to support REVOKE EXECUTE FROM authenticated.
 *   This closes a cross-tenant data exfiltration vector via PostgREST RPC.
 *   See: https://github.com/Matraca130/axon-backend/issues/45
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
import { generateText } from "../../gemini.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js";

// Fase 6: Import strategy functions + shared MatchedChunk type
import {
  selectStrategy,
  executeRetrievalEmbedding,
  rerankWithGemini,
  mergeSearchResults,
  type MatchedChunk,
  type RetrievalStrategy,
} from "../../retrieval-strategies.ts";

export const aiChatRoutes = new Hono();

// ─── Phase 5: History-augmented search query builder ────────────
// Concatenates the last 2 user messages with the current query.
// This improves recall for follow-up questions like:
//   User: "Explain mitosis"  → embed("mitosis")
//   User: "What about the phases?" → embed("mitosis phases") instead of just "phases"
//
// Each historical message is capped at 200 chars to keep the
// embedding focused. The augmented query is used ONLY for the
// embedding — the original message is what goes to Gemini.

const MAX_HISTORY_CHARS_FOR_SEARCH = 200;

function buildAugmentedQuery(
  message: string,
  history: Array<{ role: string; content: string }>,
): { query: string; wasAugmented: boolean } {
  // Extract last 2 user messages from history
  const recentUserMessages = history
    .filter((h) => h.role === "user")
    .slice(-2)
    .map((h) => h.content.slice(0, MAX_HISTORY_CHARS_FOR_SEARCH).trim())
    .filter((s) => s.length > 0);

  if (recentUserMessages.length === 0) {
    return { query: message, wasAugmented: false };
  }

  // Combine: "previous context... current question"
  const augmented = [...recentUserMessages, message].join(" ");
  return { query: augmented, wasAugmented: true };
}

// ─── Phase 5: Adjacent chunk expansion ────────────────────────────
// For each matched chunk, fetch chunks with order_index ±1 from the
// same summary. This gives the LLM better context continuity.
//
// Example: If chunk #3 matches about "cell division", we also fetch
// chunk #2 (intro context) and chunk #4 (continuation), so the LLM
// sees the full explanation instead of just one fragment.

interface ContextChunk {
  id: string;
  summary_id: string;
  content: string;
  order_index: number;
  is_primary: boolean;
}

async function fetchAdjacentChunks(
  db: SupabaseClient,
  matches: MatchedChunk[],
): Promise<ContextChunk[]> {
  if (!matches || matches.length === 0) return [];

  try {
    // Get order_index for matched chunks
    const matchedIds = matches.map((m) => m.chunk_id);
    const { data: matchedWithOrder, error: orderErr } = await db
      .from("chunks")
      .select("id, summary_id, content, order_index")
      .in("id", matchedIds);

    if (orderErr || !matchedWithOrder) return [];

    // Build set of (summary_id, order_index) pairs for adjacent chunks
    const adjacentPairs = new Set<string>();
    const matchedSet = new Set(matchedIds);

    for (const chunk of matchedWithOrder) {
      if (chunk.order_index !== null && chunk.order_index !== undefined) {
        // Previous chunk
        if (chunk.order_index > 0) {
          adjacentPairs.add(`${chunk.summary_id}:${chunk.order_index - 1}`);
        }
        // Next chunk
        adjacentPairs.add(`${chunk.summary_id}:${chunk.order_index + 1}`);
      }
    }

    if (adjacentPairs.size === 0) return [];

    // Fetch adjacent chunks
    // We need to query by (summary_id, order_index) pairs.
    // Since Supabase doesn't support tuple IN, we use OR filters.
    // Group by summary_id for efficiency.
    const summaryGroups = new Map<string, number[]>();
    for (const pair of adjacentPairs) {
      const [sumId, orderStr] = pair.split(":");
      const orderIdx = parseInt(orderStr, 10);
      if (!summaryGroups.has(sumId)) summaryGroups.set(sumId, []);
      summaryGroups.get(sumId)!.push(orderIdx);
    }

    const allContextChunks: ContextChunk[] = [];

    // Mark primary chunks
    for (const chunk of matchedWithOrder) {
      allContextChunks.push({
        id: chunk.id,
        summary_id: chunk.summary_id,
        content: chunk.content,
        order_index: chunk.order_index ?? 0,
        is_primary: true,
      });
    }

    // Fetch adjacent chunks per summary (max 3 summaries to limit queries)
    const summaryEntries = Array.from(summaryGroups.entries()).slice(0, 3);
    for (const [sumId, orderIndexes] of summaryEntries) {
      const { data: adjacent } = await db
        .from("chunks")
        .select("id, summary_id, content, order_index")
        .eq("summary_id", sumId)
        .in("order_index", orderIndexes)
        .is("deleted_at", null);

      if (adjacent) {
        for (const adj of adjacent) {
          if (!matchedSet.has(adj.id)) {
            allContextChunks.push({
              id: adj.id,
              summary_id: adj.summary_id,
              content: adj.content,
              order_index: adj.order_index ?? 0,
              is_primary: false,
            });
          }
        }
      }
    }

    // Sort by summary_id → order_index for coherent reading
    allContextChunks.sort((a, b) => {
      if (a.summary_id !== b.summary_id) return a.summary_id.localeCompare(b.summary_id);
      return a.order_index - b.order_index;
    });

    return allContextChunks;
  } catch (e) {
    console.warn("[RAG Chat] Adjacent chunk expansion failed, using primary only:", e);
    return [];
  }
}

// ─── Phase 5: Smart context assembly ──────────────────────────────
// Assembles chunks into a coherent reading context, respecting
// character limits and maintaining reading order.

const MAX_CONTEXT_CHARS = 3000;

function assembleContext(
  matches: MatchedChunk[],
  contextChunks: ContextChunk[],
): { ragContext: string; sourcesUsed: Array<{ chunk_id: string; summary_title: string; similarity: number }>; contextChunksCount: number } {
  const sourcesUsed = matches.map((m) => ({
    chunk_id: m.chunk_id,
    summary_title: m.summary_title,
    similarity: Math.round(m.similarity * 100) / 100,
  }));

  if (contextChunks.length === 0 && matches.length === 0) {
    return { ragContext: "", sourcesUsed, contextChunksCount: 0 };
  }

  // If we have expanded context chunks, use them (ordered)
  if (contextChunks.length > 0) {
    // Build a map of summary_id → title for labeling
    const titleMap = new Map<string, string>();
    for (const m of matches) {
      titleMap.set(m.summary_id, m.summary_title);
    }

    let context = "";
    let currentSummary = "";
    let charCount = 0;
    let chunksIncluded = 0;

    for (const chunk of contextChunks) {
      // Add summary header when switching summaries
      if (chunk.summary_id !== currentSummary) {
        const title = titleMap.get(chunk.summary_id) || "Material";
        const header = `\n[De "${title}"]:\n`;
        if (charCount + header.length > MAX_CONTEXT_CHARS) break;
        context += header;
        charCount += header.length;
        currentSummary = chunk.summary_id;
      }

      // Add chunk content
      const separator = chunk.is_primary ? "" : "";
      const text = `${separator}${chunk.content}\n`;
      if (charCount + text.length > MAX_CONTEXT_CHARS) {
        // Add truncated version if we have room for at least 100 chars
        const remaining = MAX_CONTEXT_CHARS - charCount;
        if (remaining > 100) {
          context += text.slice(0, remaining) + "...\n";
          chunksIncluded++;
        }
        break;
      }
      context += text;
      charCount += text.length;
      chunksIncluded++;
    }

    return {
      ragContext: context.trim()
        ? `\n\nContexto relevante del material de estudio:\n${context.trim()}`
        : "",
      sourcesUsed,
      contextChunksCount: chunksIncluded,
    };
  }

  // Fallback: use matches directly (pre-Phase 5 behavior)
  const ragContext = "\n\nContexto relevante del material de estudio:\n" +
    matches
      .map((m, i) => `[${i + 1}] (de "${m.summary_title}"): ${m.content}`)
      .join("\n\n");

  return { ragContext, sourcesUsed, contextChunksCount: matches.length };
}

// ─── Fase 3: Coarse-to-Fine result normalizer ─────────────────────
// Converts the rag_coarse_to_fine_search() RPC result into the
// MatchedChunk[] shape that fetchAdjacentChunks() and assembleContext()
// already expect. This avoids duplicating downstream logic.
//
// Mapping:
//   chunk_similarity  → similarity (primary metric for ordering)
//   0                 → text_rank  (no FTS in coarse-to-fine)
//   combined_score    → combined_score (0.3*sum + 0.7*chunk from RPC)

interface CoarseToFineRow {
  chunk_id: string;
  summary_id: string;
  summary_title: string;
  content: string;
  summary_similarity: number;
  chunk_similarity: number;
  combined_score: number;
}

function normalizeCoarseToFineResults(
  rows: CoarseToFineRow[],
): MatchedChunk[] {
  return rows.map((r) => ({
    chunk_id: r.chunk_id,
    summary_id: r.summary_id,
    summary_title: r.summary_title,
    content: r.content,
    similarity: r.chunk_similarity,
    text_rank: 0,
    combined_score: r.combined_score,
  }));
}

// ─── Fase 6: Valid strategy values for client override ────────────

const VALID_STRATEGIES = ["auto", "standard", "multi_query", "hyde"] as const;

// ─── Main route ─────────────────────────────────────────────────

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

  // ── Fase 6: Parse strategy override (D22) ───────────────────
  const requestedStrategy = typeof body.strategy === "string" ? body.strategy : "auto";
  const strategyParam = VALID_STRATEGIES.includes(requestedStrategy as typeof VALID_STRATEGIES[number])
    ? requestedStrategy
    : "auto";

  // ── Resolve institution ──────────────────────────────
  // PF-05: These DB queries validate the JWT cryptographically.
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
    // PF-01 FIX: Use 'memberships' table (not 'institution_members')
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

  // ── T-03: Start latency timer ────────────────────────────
  const t0 = Date.now();

  // ── SEC-01 FIX: Admin client for SECURITY DEFINER RPCs ─────
  // rag_hybrid_search and rag_coarse_to_fine_search are SECURITY DEFINER
  // (bypass RLS). Using adminDb allows REVOKE EXECUTE FROM authenticated,
  // closing cross-tenant data leak via PostgREST RPC.
  // Other RPCs (resolve_parent_institution, get_student_knowledge_context)
  // and table reads (memberships, chunks) keep using db (user RLS).
  // See: https://github.com/Matraca130/axon-backend/issues/45
  const adminDb = getAdminClient();

  // ── Phase 5: Build augmented search query ───────────────────
  const { query: searchQuery, wasAugmented } = buildAugmentedQuery(message, history);

  // ── Fase 6: Select retrieval strategy ──────────────────────
  const strategy: RetrievalStrategy = strategyParam === "auto"
    ? selectStrategy(message, summaryId, history.length)
    : strategyParam as RetrievalStrategy;

  // ── RAG: embed, search, merge, re-rank ─────────────────────
  let ragContext = "";
  let sourcesUsed: Array<{ chunk_id: string; summary_title: string; similarity: number }> = [];
  let contextChunksCount = 0;
  let searchType = "hybrid";
  let rerankApplied = false;
  let strategyMeta: Record<string, unknown> = {};

  try {
    // ── Fase 6: Execute strategy-specific embedding(s) ────────
    const embeddingOutput = await executeRetrievalEmbedding(
      strategy, searchQuery,
    );
    strategyMeta = embeddingOutput.strategyMeta;

    // ── Fase 6: Run search for each embedding, collect all results ──
    const allResultSets: MatchedChunk[][] = [];

    for (const { embedding } of embeddingOutput.embeddings) {
      const queryEmbeddingJson = JSON.stringify(embedding);

      let matches: MatchedChunk[] = [];

      if (summaryId) {
        // ── SCOPED: Hybrid search within specific summary ──────
        // SEC-01: Uses adminDb (service_role) — function is SECURITY DEFINER
        const { data } = await adminDb.rpc("rag_hybrid_search", {
          p_query_embedding: queryEmbeddingJson,
          p_query_text: message,
          p_institution_id: institutionId,
          p_summary_id: summaryId,
          p_match_count: 8,
          p_similarity_threshold: 0.3,
        });
        matches = (data || []) as MatchedChunk[];
        searchType = "hybrid";
      } else {
        // ── BROAD: Coarse-to-fine search (Fase 3) ──────────────
        // SEC-01: Uses adminDb (service_role) — function is SECURITY DEFINER
        const { data: c2fData, error: c2fErr } = await adminDb.rpc(
          "rag_coarse_to_fine_search",
          {
            p_query_embedding: queryEmbeddingJson,
            p_institution_id: institutionId,
            p_top_summaries: 3,
            p_top_chunks: 8,
            p_similarity_threshold: 0.3,
          },
        );

        if (!c2fErr && c2fData && c2fData.length > 0) {
          matches = normalizeCoarseToFineResults(c2fData as CoarseToFineRow[]);
          searchType = "coarse_to_fine";
        } else {
          // ── FALLBACK: hybrid search (unscoped) ───────────────
          if (c2fErr) {
            console.warn(
              "[RAG Chat] Coarse-to-fine RPC failed, using hybrid fallback:",
              c2fErr.message,
            );
          }

          // SEC-01: Uses adminDb (service_role) — function is SECURITY DEFINER
          const { data: hybridData } = await adminDb.rpc("rag_hybrid_search", {
            p_query_embedding: queryEmbeddingJson,
            p_query_text: message,
            p_institution_id: institutionId,
            p_summary_id: null,
            p_match_count: 8,
            p_similarity_threshold: 0.3,
          });
          matches = (hybridData || []) as MatchedChunk[];
          searchType = "hybrid_fallback";
        }
      }

      allResultSets.push(matches);
    }

    // ── Fase 6: Merge results from all embeddings (dedup) ───────
    let mergedMatches = mergeSearchResults(allResultSets);

    // ── Fase 6: Re-rank via Gemini-as-Judge (D20: always apply) ──
    if (mergedMatches.length > 1) {
      try {
        mergedMatches = await rerankWithGemini(message, mergedMatches, 5);
        rerankApplied = true;
      } catch (e) {
        console.warn("[RAG Chat] Re-ranking failed, using original order:", (e as Error).message);
      }
    }

    if (mergedMatches.length > 0) {
      // Phase 5: Fetch adjacent chunks for context expansion
      const topMatches = mergedMatches.slice(0, 5);
      const contextChunks = await fetchAdjacentChunks(db, topMatches);

      // Phase 5: Assemble coherent context
      const assembled = assembleContext(topMatches, contextChunks);
      ragContext = assembled.ragContext;
      sourcesUsed = assembled.sourcesUsed;
      contextChunksCount = assembled.contextChunksCount;
    }
  } catch (e) {
    console.warn("[RAG Chat] Search failed, continuing without context:", e);
  }

  // ── Fetch student profile ──────────────────────────────
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

  // ── Build conversation ───────────────────────────────
  const systemPrompt = `Eres un tutor educativo amable y preciso.
Responde basandote en el contexto proporcionado del material de estudio.
Si no tienes informacion suficiente, dilo honestamente.
Adapta la complejidad de tu respuesta al nivel del alumno.
Responde en espanol.${profileContext}`;

  const conversationHistory = history
    .map((h: Record<string, string>) => `${h.role === "user" ? "Alumno" : "Tutor"}: ${h.content}`)
    .join("\n");

  const userPrompt = `${conversationHistory ? `Conversacion previa:\n${conversationHistory}\n\n` : ""}Alumno: ${message}${ragContext}`;

  // ── Generate response ────────────────────────────────
  try {
    const result = await generateText({
      prompt: userPrompt,
      systemPrompt,
      temperature: 0.5,
      maxTokens: 1500,
    });

    // ── T-03 + Fase 3 + Fase 6: Compute metrics and log query ──
    const latencyMs = Date.now() - t0;
    const sims = sourcesUsed.map((s) => s.similarity);
    const logId = crypto.randomUUID();

    // Fase 3: Combine search strategy + augmentation for full observability
    const logSearchType = wasAugmented ? `${searchType}_augmented` : searchType;

    // Fire-and-forget: INSERT via adminClient (bypass RLS).
    getAdminClient()
      .from("rag_query_log")
      .insert({
        id: logId,
        user_id: user.id,
        institution_id: institutionId,
        query_text: message,
        summary_id: summaryId,
        results_count: sourcesUsed.length,
        top_similarity: sims.length ? Math.max(...sims) : null,
        avg_similarity: sims.length
          ? Math.round((sims.reduce((a, b) => a + b, 0) / sims.length) * 1000) / 1000
          : null,
        latency_ms: latencyMs,
        search_type: logSearchType,
        model_used: "gemini-2.5-flash",
        // Fase 6: New columns
        retrieval_strategy: strategy,
        rerank_applied: rerankApplied,
      })
      .then(({ error }) => {
        if (error) console.warn("[RAG Log] Insert failed:", error.message);
      });

    return ok(c, {
      response: result.text,
      sources: sourcesUsed,
      tokens: result.tokensUsed,
      profile_used: !!profileContext,
      log_id: logId,
      // Phase 5 + Fase 3 + Fase 6: Search metadata
      _search: {
        augmented: wasAugmented,
        search_type: searchType,
        context_chunks: contextChunksCount,
        primary_matches: sourcesUsed.length,
        // Fase 6 metadata
        strategy,
        rerank_applied: rerankApplied,
        ...strategyMeta,
      },
    });
  } catch (e) {
    console.error("[RAG Chat] Gemini error:", e);
    return err(c, `Chat failed: ${(e as Error).message}`, 500);
  }
});
