/**
 * routes/ai/chat/types.ts — Shared types & fallback trace
 *
 * Extracted from routes/ai/chat.ts during split refactor
 * (refactor/chat-split-modules). Contains the type-only surface area
 * shared across retrieval.ts, context-assembly.ts and the thin route
 * handler in chat.ts.
 *
 * - ContextChunk: primary/adjacent chunk row used during assembly.
 * - CoarseToFineRow: shape returned by rag_coarse_to_fine_search RPC.
 * - FallbackTrace: per-request diagnostics for the topic fallback
 *   cascade (RL-DEBUG-3).
 */

export interface ContextChunk {
  id: string;
  summary_id: string;
  content: string;
  order_index: number;
  is_primary: boolean;
}

export interface CoarseToFineRow {
  chunk_id: string;
  summary_id: string;
  summary_title: string;
  content: string;
  summary_similarity: number;
  chunk_similarity: number;
  combined_score: number;
}

// DEBUG (RL-DEBUG-3): track per-step diagnostics for the fallback
// cascade so we can see WHERE it returns empty. Stashed into the
// shared debugTopicFallbackTrace array by the caller.
export interface FallbackTrace {
  topicSummariesCount: number;
  topicSummariesError: string | null;
  perSummary: Array<{
    sid: string;
    rowFound: boolean;
    summaryError: string | null;
    chunkRows: number;
    chunkError: string | null;
    blockRows: number;
    blockError: string | null;
    mdLen: number;
    matchesReturned: number;
  }>;
}

export function newFallbackTrace(): FallbackTrace {
  return { topicSummariesCount: 0, topicSummariesError: null, perSummary: [] };
}
