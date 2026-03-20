/**
 * retrieval-strategies.ts — Fase 6: Advanced retrieval strategies for Axon RAG
 *
 * Pure functions for Multi-Query, HyDE, Re-ranking, and Strategy Selection.
 * All async functions have graceful degradation (never throw to caller).
 *
 * Strategies:
 *   standard    — single embedding of the query (pre-Fase 6 behavior)
 *   multi_query — Claude generates 2 reformulations, embed all 3 in parallel
 *   hyde        — Claude generates hypothetical answer, embed that instead
 *
 * Post-processor:
 *   rerankWithClaude() — scores chunk relevance, blends with original score
 *
 * Decisions:
 *   D19: Separate file (chat.ts already 21KB)
 *   D21: Parallel embeddings for multi_query (Promise.all)
 *   D23: Score blend: 0.6 × rerank + 0.4 × original
 *   D24: HyDE replaces query embedding (research shows better results)
 *   D27: 2 reformulations (not 3) to save Claude RPM
 *   D28: Temperature 0.8 for reformulations (diversity)
 *   D29: Temperature 0.0 for re-ranking (deterministic scoring)
 *   D30: Temperature 0.3 for HyDE (factual content)
 *   D57-D62: Embedding migration — generateEmbedding now from openai-embeddings.ts
 *            (OpenAI text-embedding-3-large 1536d). taskType parameter removed.
 *
 * Audit R1 fix: selectStrategy checks historyLength before wordCount
 * W7-RAG02 FIX: Removed unreachable default return in selectStrategy()
 */

// D57: Embeddings from OpenAI, text generation from Claude
import { generateEmbedding } from "./openai-embeddings.ts";
import { generateText, parseClaudeJson } from "./claude-ai.ts";
import { sanitizeForPrompt, wrapXml } from "./prompt-sanitize.ts";

// ─── Types ────────────────────────────────────────────────────────

/** Shared type for RAG search results. Exported for use in chat.ts. */
export interface MatchedChunk {
  chunk_id: string;
  summary_id: string;
  summary_title: string;
  content: string;
  similarity: number;
  text_rank: number;
  combined_score: number;
}

export type RetrievalStrategy = "standard" | "multi_query" | "hyde";

interface EmbeddingResult {
  query: string;
  embedding: number[];
}

export interface RetrievalEmbeddingOutput {
  embeddings: EmbeddingResult[];
  strategyMeta: Record<string, unknown>;
}

// ─── Strategy Selection (pure function) ───────────────────────────

/**
 * Selects the best retrieval strategy based on query characteristics.
 *
 * Priority order (highest first):
 *   1. summaryId present    → "standard" (scoped search is already precise)
 *   2. historyLength > 2    → "multi_query" (deep conversation → reformulations)
 *   3. wordCount ≤ 5        → "hyde" (short factual questions benefit most)
 *   4. wordCount > 5        → "multi_query" (complex questions → reformulations)
 *
 * Audit R1 fix: historyLength checked before wordCount.
 * Rationale: multi-turn dialog benefits more from query reformulation
 * than from a hypothetical answer, even when the latest message is short.
 *
 * W7-RAG02 FIX: The old code had an unreachable `return "standard"` after
 * exhaustive if/else branches. Replaced with explicit else for clarity.
 */
export function selectStrategy(
  message: string,
  summaryId: string | null,
  historyLength: number,
): RetrievalStrategy {
  // Scoped search is already precise — no advanced strategy needed
  if (summaryId) return "standard";

  // R1 FIX: Deep conversation history has highest priority (after scoped)
  // Multi-turn dialog → reformulations catch context from prior messages
  // Task 4.4: Raise threshold from > 2 to > 4 — avoid multi_query overhead for short conversations
  if (historyLength > 4) return "multi_query";

  const wordCount = message.trim().split(/\s+/).length;

  // Short questions → HyDE (hypothetical answer embedding)
  if (wordCount <= 5) return "hyde";

  // W7-RAG02 FIX: Explicit else instead of unreachable default.
  // Long/complex questions → Multi-Query (reformulations)
  return "multi_query";
}

// ─── Multi-Query: Claude generates reformulations ─────────────────

/**
 * Generates 2 alternative reformulations of the user's query.
 * Uses diverse temperature (0.8) for synonym/perspective variety.
 *
 * Graceful degradation: returns [] on any error.
 *
 * D27: 2 reformulations (not 3) to save Claude RPM.
 * D28: Temperature 0.8 for diversity.
 */
export async function generateMultiQueries(
  originalQuery: string,
): Promise<string[]> {
  try {
    const result = await generateText({
      prompt: `Genera exactamente 2 reformulaciones diferentes de esta pregunta de estudio.
Cada reformulación debe usar sinónimos o enfocar un aspecto diferente del tema.
No repitas la pregunta original.

${wrapXml('original_query', sanitizeForPrompt(originalQuery, 500))}

Responde SOLO con JSON: { "queries": ["reformulacion1", "reformulacion2"] }`,
      systemPrompt:
        "Eres un asistente que reformula preguntas educativas para mejorar la búsqueda semántica. Responde SOLO con JSON válido.",
      jsonMode: true,
      temperature: 0.8,
      maxTokens: 256,
    });

    const parsed = parseClaudeJson<{ queries: string[] }>(result.text);
    if (!Array.isArray(parsed.queries)) return [];

    // Sanitize: only keep non-empty strings, limit to 2
    return parsed.queries
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .slice(0, 2);
  } catch (e) {
    console.warn("[Fase 6] Multi-query generation failed, using original only:", (e as Error).message);
    return [];
  }
}

// ─── HyDE: Hypothetical Document Embedding ────────────────────────

/**
 * Generates a hypothetical document (2-3 sentences) that would answer
 * the user's query. The hypothesis is then embedded instead of the
 * original query, bridging the question-answer embedding gap.
 *
 * Graceful degradation: returns "" on any error (caller uses original query).
 *
 * D24: Hypothesis replaces query embedding (research shows better results).
 * D30: Temperature 0.3 for factual content.
 */
export async function generateHypotheticalDocument(
  query: string,
): Promise<string> {
  try {
    const result = await generateText({
      prompt: `Escribe un párrafo corto (2-3 oraciones) que responda directamente esta pregunta de estudio, como si fuera un fragmento de un libro de texto universitario.

${wrapXml('query', sanitizeForPrompt(query, 500))}

Responde SOLO con el párrafo, sin explicaciones adicionales ni prefijos.`,
      systemPrompt:
        "Eres un libro de texto educativo universitario. Genera contenido factual, preciso y conciso en español.",
      temperature: 0.3,
      maxTokens: 200,
    });

    const text = result.text.trim();
    return text.length > 0 ? text : "";
  } catch (e) {
    console.warn("[Fase 6] HyDE generation failed, using original query:", (e as Error).message);
    return "";
  }
}

// ─── Re-ranking: Claude-as-Judge ──────────────────────────────────

/**
 * Re-ranks search results by asking Claude to score each chunk's
 * relevance to the query on a 0-10 scale.
 *
 * Score blending: final = 0.6 × (claude_score / 10) + 0.4 × original_combined_score
 * This preserves the original search signal while letting Claude refine ordering.
 *
 * Graceful degradation: returns original chunks on any error.
 *
 * D23: 0.6/0.4 blend ratio.
 * D25: Uses all input chunks (chat.ts already limits to 8).
 * D29: Temperature 0.0 for deterministic scoring.
 */
export async function rerankWithClaude(
  query: string,
  chunks: MatchedChunk[],
  topK: number = 5,
): Promise<MatchedChunk[]> {
  if (chunks.length <= 1) return chunks.slice(0, topK);

  try {
    // Truncate each chunk to 300 chars for the scoring prompt
    const chunkList = chunks
      .map(
        (c, i) =>
          `[${i}] (de "${sanitizeForPrompt(c.summary_title, 100)}"): ${sanitizeForPrompt(c.content, 300)}`,
      )
      .join("\n");

    const result = await generateText({
      prompt: `Evalúa la relevancia de cada fragmento para responder esta pregunta de estudio.

${wrapXml('query', sanitizeForPrompt(query, 500))}

Fragmentos:
${chunkList}

Para cada fragmento, asigna un score de 0 a 10 donde:
- 0 = completamente irrelevante
- 5 = parcialmente relevante
- 10 = perfectamente relevante y responde directamente la pregunta

Responde SOLO con JSON: { "scores": [score0, score1, ...] }`,
      systemPrompt:
        "Eres un evaluador de relevancia semántica para contenido educativo. Responde SOLO con JSON válido.",
      model: "haiku",
      jsonMode: true,
      temperature: 0.0,
      maxTokens: 128,
    });

    const parsed = parseClaudeJson<{ scores: number[] }>(result.text);
    const scores = parsed.scores;

    if (!Array.isArray(scores) || scores.length === 0) {
      console.warn("[Fase 6] Re-ranker returned invalid scores, using original order");
      return chunks.slice(0, topK);
    }

    // D23: Blend rerank score with original combined_score
    const rescored = chunks.map((chunk, i) => {
      const claudeScore = typeof scores[i] === "number" ? scores[i] : 5;
      // Clamp to 0-10
      const clampedScore = Math.max(0, Math.min(10, claudeScore));
      return {
        ...chunk,
        combined_score:
          (clampedScore / 10) * 0.6 + chunk.combined_score * 0.4,
      };
    });

    return rescored
      .sort((a, b) => b.combined_score - a.combined_score)
      .slice(0, topK);
  } catch (e) {
    console.warn("[Fase 6] Re-ranking failed, using original order:", (e as Error).message);
    return chunks.slice(0, topK);
  }
}

// ─── Merge: Deduplicate results from multiple searches ────────────

/**
 * Merges results from multiple search executions (e.g., multi-query).
 * Keeps the highest combined_score per chunk_id.
 * Returns results sorted by combined_score descending.
 *
 * Pure function — no network calls.
 */
export function mergeSearchResults(
  resultSets: MatchedChunk[][],
): MatchedChunk[] {
  const bestByChunkId = new Map<string, MatchedChunk>();

  for (const results of resultSets) {
    for (const match of results) {
      const existing = bestByChunkId.get(match.chunk_id);
      if (!existing || match.combined_score > existing.combined_score) {
        bestByChunkId.set(match.chunk_id, match);
      }
    }
  }

  return Array.from(bestByChunkId.values()).sort(
    (a, b) => b.combined_score - a.combined_score,
  );
}

// ─── Orchestrator: Execute strategy-specific embedding(s) ─────────

/**
 * Executes the embedding step according to the selected strategy.
 *
 * - standard:    1 embedding of the search query
 * - multi_query: embed original + 2 Claude reformulations (parallel, D21)
 * - hyde:        embed Claude's hypothetical answer (replaces query, D24)
 *
 * Returns an array of {query, embedding} pairs for chat.ts to run
 * N searches and merge results.
 *
 * Graceful degradation: if multi_query/hyde generation fails,
 * falls back to single original query embedding.
 *
 * D57: embedFn signature simplified to (text: string) => Promise<number[]>
 *      (OpenAI doesn't need taskType). Default uses OpenAI generateEmbedding.
 */
export async function executeRetrievalEmbedding(
  strategy: RetrievalStrategy,
  searchQuery: string,
  embedFn: (text: string) => Promise<number[]> = generateEmbedding,
): Promise<RetrievalEmbeddingOutput> {
  // ── STANDARD: single embedding ───────────────────────────────
  if (strategy === "standard") {
    const embedding = await embedFn(searchQuery);
    return {
      embeddings: [{ query: searchQuery, embedding }],
      strategyMeta: {},
    };
  }

  // ── MULTI-QUERY: original + 2 reformulations in parallel ────
  if (strategy === "multi_query") {
    const reformulations = await generateMultiQueries(searchQuery);
    const allQueries = [searchQuery, ...reformulations];

    // D21: Embed all queries in parallel
    const embeddingPromises = allQueries.map(async (q) => {
      try {
        const embedding = await embedFn(q);
        return { query: q, embedding };
      } catch (e) {
        console.warn(`[Fase 6] Embedding failed for reformulation: ${(e as Error).message}`);
        return null;
      }
    });

    const results = await Promise.all(embeddingPromises);
    const validResults = results.filter((r): r is EmbeddingResult => r !== null);

    // If all embeddings failed, this is a critical error — let it propagate
    if (validResults.length === 0) {
      throw new Error("All multi-query embeddings failed");
    }

    return {
      embeddings: validResults,
      strategyMeta: {
        multi_query_count: validResults.length,
        reformulations: reformulations,
      },
    };
  }

  // ── HYDE: embed hypothetical document ────────────────────────
  // W7-RAG02 FIX: This is now the final branch (was `if` with unreachable default).
  // TypeScript knows strategy is "hyde" here due to exhaustive checks above.
  const hypothesis = await generateHypotheticalDocument(searchQuery);

  if (hypothesis.length > 0) {
    // D24: Embed the hypothesis, not the original query
    const embedding = await embedFn(hypothesis);
    return {
      embeddings: [{ query: hypothesis, embedding }],
      strategyMeta: {
        hyde_used: true,
        hypothesis_length: hypothesis.length,
      },
    };
  }

  // Fallback: HyDE generation failed, use original query
  console.warn("[Fase 6] HyDE produced empty hypothesis, falling back to standard");
  const embedding = await embedFn(searchQuery);
  return {
    embeddings: [{ query: searchQuery, embedding }],
    strategyMeta: { hyde_used: false, hyde_fallback: true },
  };
}
