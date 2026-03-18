/**
 * lib/rag-search.ts -- Shared RAG search helper
 *
 * Extracted from whatsapp/tools.ts and telegram/tools.ts to eliminate duplication.
 * Both messaging bots use the same RAG pipeline:
 *   1. Resolve institution_id (tenant scoping)
 *   2. Select retrieval strategy
 *   3. Generate embeddings
 *   4. Hybrid search (pgvector + BM25)
 *   5. Re-rank with Claude
 *   6. Assemble context string
 */

import { getAdminClient } from "../db.ts";
import {
  selectStrategy,
  executeRetrievalEmbedding,
  rerankWithClaude,
  mergeSearchResults,
  type MatchedChunk,
} from "../retrieval-strategies.ts";

// ─── Config ──────────────────────────────────────────────

const RAG_MAX_CONTEXT_CHARS = 4000;
const RAG_TOP_K = 5;

// ─── Types ───────────────────────────────────────────────

export interface RagSearchResult {
  context: string;
  sources: string[];
  strategy: string;
}

// ─── Shared ragSearch ────────────────────────────────────

export async function ragSearch(
  question: string,
  userId: string,
  summaryId?: string,
): Promise<RagSearchResult> {
  const db = getAdminClient();

  try {
    // Resolve institution for tenant-scoped search
    let institutionId: string | null = null;

    if (summaryId) {
      const { data: instId } = await db.rpc("resolve_parent_institution", {
        p_table: "summaries",
        p_id: summaryId,
      });
      institutionId = instId as string | null;
    }

    if (!institutionId) {
      const { data: membership } = await db
        .from("memberships")
        .select("institution_id")
        .eq("user_id", userId)
        .eq("is_active", true)
        .limit(1)
        .single();
      institutionId = membership?.institution_id ?? null;
    }

    if (!institutionId) {
      return { context: "", sources: [], strategy: "no_institution" };
    }

    const strategy = summaryId ? "standard" : selectStrategy(question, summaryId ?? null, 0);
    const { embeddings } = await executeRetrievalEmbedding(strategy, question);

    const searchPromises = embeddings.map(async ({ embedding }) => {
      const { data, error } = await db.rpc("rag_hybrid_search", {
        p_query_embedding: JSON.stringify(embedding),
        p_query_text: question,
        p_institution_id: institutionId,
        p_match_count: RAG_TOP_K * 2,
        p_similarity_threshold: 0.3,
        p_summary_id: summaryId ?? null,
      });

      if (error) {
        console.warn(`[RAG] hybrid search failed: ${error.message}`);
        return [] as MatchedChunk[];
      }
      return (data ?? []) as MatchedChunk[];
    });

    const resultSets = await Promise.all(searchPromises);
    let merged = mergeSearchResults(resultSets);

    if (merged.length === 0) {
      return { context: "", sources: [], strategy: `${strategy}_empty` };
    }

    merged = await rerankWithClaude(question, merged, RAG_TOP_K);

    let contextChars = 0;
    const contextParts: string[] = [];
    const sources: string[] = [];

    for (const chunk of merged) {
      if (contextChars + chunk.content.length > RAG_MAX_CONTEXT_CHARS) {
        const remaining = RAG_MAX_CONTEXT_CHARS - contextChars;
        if (remaining > 200) {
          contextParts.push(
            `## ${chunk.summary_title}\n${chunk.content.slice(0, remaining)}...`,
          );
        }
        break;
      }
      contextParts.push(`## ${chunk.summary_title}\n${chunk.content}`);
      contextChars += chunk.content.length;
      if (!sources.includes(chunk.summary_title)) {
        sources.push(chunk.summary_title);
      }
    }

    return {
      context: contextParts.join("\n\n"),
      sources,
      strategy,
    };
  } catch (e) {
    console.error(`[RAG] Pipeline failed: ${(e as Error).message}`);
    return { context: "", sources: [], strategy: "error" };
  }
}
