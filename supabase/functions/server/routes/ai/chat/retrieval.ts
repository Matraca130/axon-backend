/**
 * routes/ai/chat/retrieval.ts — Chunk retrieval & fallback cascade
 *
 * Extracted from routes/ai/chat.ts during split refactor
 * (refactor/chat-split-modules). Owns everything that touches Supabase
 * to pull chunks out of the database, including:
 *
 *   - fetchAdjacentChunks: Phase 5 +/-1 order_index expansion.
 *   - fetchSummaryFallbackChunks: cascading fallback
 *       (chunks -> summary_blocks -> content_markdown) when vector
 *       search returns zero hits for a given summary.
 *   - fetchSummaryFallbackChunksTraced: same as above but records
 *     per-step diagnostics into a FallbackTrace (RL-DEBUG-3).
 *   - fetchTopicFallbackChunks: iterates every active summary under a
 *     topic and runs the traced cascade per summary.
 *   - normalizeCoarseToFineResults: adapter from the
 *     rag_coarse_to_fine_search RPC row shape to MatchedChunk.
 *   - extractTextFromBlockContent: JSONB walker used by both fallback
 *     cascades to coerce summary_blocks.content into a flat string.
 *
 * Pure extraction — no behavioral change vs. the original chat.ts.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";
import type { MatchedChunk } from "../../../retrieval-strategies.ts";
import {
  type ContextChunk,
  type CoarseToFineRow,
  type FallbackTrace,
  newFallbackTrace,
} from "./types.ts";
import { ADJACENT_FETCH_MAX_SUMMARIES } from "./constants.ts";

// --- Phase 5: Adjacent chunk expansion ----------------------------

export async function fetchAdjacentChunks(
  db: SupabaseClient,
  matches: MatchedChunk[],
): Promise<ContextChunk[]> {
  if (!matches || matches.length === 0) return [];

  try {
    const matchedIds = matches.map((m) => m.chunk_id);
    const { data: matchedWithOrder, error: orderErr } = await db
      .from("chunks")
      .select("id, summary_id, content, order_index")
      .in("id", matchedIds)
      .is("deleted_at", null);

    if (orderErr || !matchedWithOrder) return [];

    const adjacentPairs = new Set<string>();
    const matchedSet = new Set(matchedIds);

    for (const chunk of matchedWithOrder) {
      if (chunk.order_index !== null && chunk.order_index !== undefined) {
        if (chunk.order_index > 0) {
          adjacentPairs.add(`${chunk.summary_id}:${chunk.order_index - 1}`);
        }
        adjacentPairs.add(`${chunk.summary_id}:${chunk.order_index + 1}`);
      }
    }

    if (adjacentPairs.size === 0) return [];

    const summaryGroups = new Map<string, number[]>();
    for (const pair of adjacentPairs) {
      const [sumId, orderStr] = pair.split(":");
      const orderIdx = parseInt(orderStr, 10);
      if (!summaryGroups.has(sumId)) summaryGroups.set(sumId, []);
      summaryGroups.get(sumId)!.push(orderIdx);
    }

    const allContextChunks: ContextChunk[] = [];

    for (const chunk of matchedWithOrder) {
      allContextChunks.push({
        id: chunk.id,
        summary_id: chunk.summary_id,
        content: chunk.content,
        order_index: chunk.order_index ?? 0,
        is_primary: true,
      });
    }

    // Consolidated single query: fetch all adjacent chunks at once
    // instead of N queries per summary group (fixes N+1 loop).
    const summaryEntries = Array.from(summaryGroups.entries()).slice(0, ADJACENT_FETCH_MAX_SUMMARIES);
    const allSummaryIds = summaryEntries.map(([sumId]) => sumId);
    const allOrderIndexes = new Set<number>();
    for (const [, orderIndexes] of summaryEntries) {
      for (const idx of orderIndexes) allOrderIndexes.add(idx);
    }

    if (allSummaryIds.length > 0 && allOrderIndexes.size > 0) {
      const { data: adjacentBatch } = await db
        .from("chunks")
        .select("id, summary_id, content, order_index")
        .in("summary_id", allSummaryIds)
        .in("order_index", Array.from(allOrderIndexes))
        .is("deleted_at", null);

      if (adjacentBatch) {
        // Build a lookup set for valid (summary_id, order_index) pairs
        const validPairs = new Set(
          summaryEntries.flatMap(([sumId, indexes]) =>
            indexes.map((idx) => `${sumId}:${idx}`)
          ),
        );

        for (const adj of adjacentBatch) {
          const pairKey = `${adj.summary_id}:${adj.order_index}`;
          if (!matchedSet.has(adj.id) && validPairs.has(pairKey)) {
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

// --- Fallback: direct summary content (no vector search) --------
//
// When `summary_id` is provided but vector search returns zero hits,
// the user was asking about a topic they are actively viewing, so we
// should still send the topic content to the LLM instead of letting
// it hallucinate from general knowledge. Triggered by short queries
// (e.g. acronyms like "EIC") whose embeddings score below the
// similarity threshold, or by summaries whose chunks are not yet
// embedded. See: Axon AI "EIC" bug report.
//
// Cascading source priority:
//   1. chunks             — if the summary has been ingested for RAG
//   2. summary_blocks     — Smart Reader block format (heading/paragraph)
//   3. content_markdown   — raw summary body as a last resort
//
// Summaries with `last_chunked_at IS NULL` (never ingested) will fall
// through to summary_blocks / content_markdown instead of returning
// empty context.

const FALLBACK_CHUNK_LIMIT = 12;
const FALLBACK_BLOCK_LIMIT = 40;
const FALLBACK_MARKDOWN_MAX_CHARS = 7000;

// summary_blocks.content is JSONB with shape varying by `type`:
//   prose / key_point  → { title, content }
//   list_detail        → { intro, items: [...] }
//   image_reference    → { alt, src }
//   stages             → { items: [{ stage, title, content }, ...] }
//   ...and others
//
// We can't enumerate every shape (the schema evolves), so this helper
// walks the JSONB recursively and concatenates every string value it
// finds. Lossy but robust: the LLM gets all the prose without us
// having to maintain a per-type extractor. URLs etc. leak through —
// acceptable trade-off vs. crashing on `content.trim()`.
export function extractTextFromBlockContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") {
    return String(content);
  }
  if (Array.isArray(content)) {
    return content
      .map(extractTextFromBlockContent)
      .filter((s) => s.length > 0)
      .join("\n");
  }
  if (typeof content === "object") {
    const parts: string[] = [];
    for (const v of Object.values(content as Record<string, unknown>)) {
      const s = extractTextFromBlockContent(v);
      if (s) parts.push(s);
    }
    return parts.join("\n");
  }
  return "";
}

export async function fetchSummaryFallbackChunks(
  adminDb: SupabaseClient,
  summaryId: string,
): Promise<MatchedChunk[]> {
  // SEC-S9B convention: use the admin client (bypasses RLS) for
  // cross-table content fetches in the RAG path. The user's `db`
  // client is filtered by RLS policies that may exclude legitimate
  // educational content (e.g. summary_blocks "Professors manage"
  // policy denies students), which would silently empty the cascade.
  try {
    const { data: summaryRow } = await adminDb
      .from("summaries")
      .select("id, title, content_markdown")
      .eq("id", summaryId)
      .is("deleted_at", null)
      .single();

    if (!summaryRow) return [];

    const title = (summaryRow.title as string) || "Material";
    const summaryIdStr = summaryRow.id as string;

    const makeMatch = (
      id: string,
      content: string,
    ): MatchedChunk => ({
      chunk_id: id,
      summary_id: summaryIdStr,
      summary_title: title,
      content,
      similarity: 0,
      text_rank: 0,
      combined_score: 0,
    });

    // 1. chunks (canonical ingested form)
    // NOTE: chunks table has no deleted_at column — filtering by it
    // makes PostgREST reject the query and return data: null, which
    // silently masks the rest of the cascade. Order by order_index
    // is enough.
    const { data: chunkRows } = await adminDb
      .from("chunks")
      .select("id, summary_id, content, order_index")
      .eq("summary_id", summaryId)
      .order("order_index", { ascending: true })
      .limit(FALLBACK_CHUNK_LIMIT);

    if (chunkRows && chunkRows.length > 0) {
      return chunkRows.map((row) =>
        makeMatch(row.id as string, row.content as string),
      );
    }

    // 2. summary_blocks (Smart Reader format)
    const { data: blockRows } = await adminDb
      .from("summary_blocks")
      .select("id, type, heading_text, heading_level, content, order_index")
      .eq("summary_id", summaryId)
      .eq("is_active", true)
      .order("order_index", { ascending: true })
      .limit(FALLBACK_BLOCK_LIMIT);

    if (blockRows && blockRows.length > 0) {
      return blockRows
        .map((row) => {
          const type = row.type as string;
          if (type === "heading" && row.heading_text) {
            const level = (row.heading_level as number) || 2;
            const hashes = "#".repeat(Math.min(Math.max(level, 1), 6));
            return makeMatch(row.id as string, `${hashes} ${row.heading_text}`);
          }
          // summary_blocks.content is JSONB — extract all string values.
          const text = extractTextFromBlockContent(row.content).trim();
          return text ? makeMatch(row.id as string, text) : null;
        })
        .filter((m): m is MatchedChunk => m !== null);
    }

    // 3. content_markdown (raw summary body)
    const markdown = (summaryRow.content_markdown as string | null) || "";
    if (markdown.trim()) {
      const truncated = markdown.length > FALLBACK_MARKDOWN_MAX_CHARS
        ? markdown.slice(0, FALLBACK_MARKDOWN_MAX_CHARS) + "\n..."
        : markdown;
      return [makeMatch(`${summaryIdStr}:markdown`, truncated)];
    }

    return [];
  } catch (e) {
    console.warn("[RAG Chat] Summary fallback fetch failed:", (e as Error).message);
    return [];
  }
}

// --- Fallback: all summaries under a topic (no summary_id) -------
//
// When the user is browsing a topic rather than a specific summary
// (e.g. UI shows "Contexto: Examen Fisico Cardiovascular" from the
// navigation context, but no `:summaryId` is in the URL and the user
// hasn't opened an individual summary yet), the chat body arrives
// with `topic_id` but no `summary_id`. We load every active summary
// under that topic and feed their content to the LLM via the same
// chunks → summary_blocks → content_markdown cascade.

const FALLBACK_TOPIC_SUMMARIES_LIMIT = 6;

export async function fetchSummaryFallbackChunksTraced(
  adminDb: SupabaseClient,
  summaryId: string,
  trace: FallbackTrace,
): Promise<MatchedChunk[]> {
  const entry = {
    sid: summaryId.slice(0, 8),
    rowFound: false,
    summaryError: null as string | null,
    chunkRows: 0,
    chunkError: null as string | null,
    blockRows: 0,
    blockError: null as string | null,
    mdLen: 0,
    matchesReturned: 0,
  };
  trace.perSummary.push(entry);

  try {
    const { data: summaryRow, error: summaryErr } = await adminDb
      .from("summaries")
      .select("id, title, content_markdown")
      .eq("id", summaryId)
      .is("deleted_at", null)
      .single();

    if (summaryErr) entry.summaryError = summaryErr.message.slice(0, 60);
    if (!summaryRow) return [];
    entry.rowFound = true;

    const title = (summaryRow.title as string) || "Material";
    const summaryIdStr = summaryRow.id as string;
    const markdown = (summaryRow.content_markdown as string | null) || "";
    entry.mdLen = markdown.length;

    const makeMatch = (id: string, content: string): MatchedChunk => ({
      chunk_id: id,
      summary_id: summaryIdStr,
      summary_title: title,
      content,
      similarity: 0,
      text_rank: 0,
      combined_score: 0,
    });

    // 1. chunks
    const { data: chunkRows, error: chunkErr } = await adminDb
      .from("chunks")
      .select("id, summary_id, content, order_index")
      .eq("summary_id", summaryId)
      .order("order_index", { ascending: true })
      .limit(FALLBACK_CHUNK_LIMIT);

    if (chunkErr) entry.chunkError = chunkErr.message.slice(0, 60);
    entry.chunkRows = chunkRows?.length ?? 0;

    if (chunkRows && chunkRows.length > 0) {
      const matches = chunkRows.map((row) =>
        makeMatch(row.id as string, row.content as string),
      );
      entry.matchesReturned = matches.length;
      return matches;
    }

    // 2. summary_blocks
    const { data: blockRows, error: blockErr } = await adminDb
      .from("summary_blocks")
      .select("id, type, heading_text, heading_level, content, order_index")
      .eq("summary_id", summaryId)
      .eq("is_active", true)
      .order("order_index", { ascending: true })
      .limit(FALLBACK_BLOCK_LIMIT);

    if (blockErr) entry.blockError = blockErr.message.slice(0, 60);
    entry.blockRows = blockRows?.length ?? 0;

    if (blockRows && blockRows.length > 0) {
      const matches = blockRows
        .map((row) => {
          const type = row.type as string;
          if (type === "heading" && row.heading_text) {
            const level = (row.heading_level as number) || 2;
            const hashes = "#".repeat(Math.min(Math.max(level, 1), 6));
            return makeMatch(row.id as string, `${hashes} ${row.heading_text}`);
          }
          // summary_blocks.content is JSONB — extract all string values.
          const text = extractTextFromBlockContent(row.content).trim();
          return text ? makeMatch(row.id as string, text) : null;
        })
        .filter((m): m is MatchedChunk => m !== null);
      entry.matchesReturned = matches.length;
      return matches;
    }

    // 3. content_markdown
    if (markdown.trim()) {
      const truncated = markdown.length > FALLBACK_MARKDOWN_MAX_CHARS
        ? markdown.slice(0, FALLBACK_MARKDOWN_MAX_CHARS) + "\n..."
        : markdown;
      const matches = [makeMatch(`${summaryIdStr}:markdown`, truncated)];
      entry.matchesReturned = matches.length;
      return matches;
    }

    return [];
  } catch (e) {
    entry.summaryError = `EXC: ${(e as Error).message.slice(0, 50)}`;
    return [];
  }
}

export async function fetchTopicFallbackChunks(
  adminDb: SupabaseClient,
  topicId: string,
  trace?: FallbackTrace,
): Promise<MatchedChunk[]> {
  const t = trace ?? newFallbackTrace();
  try {
    const { data: summaryRows, error: summariesErr } = await adminDb
      .from("summaries")
      .select("id")
      .eq("topic_id", topicId)
      .is("deleted_at", null)
      .order("order_index", { ascending: true })
      .limit(FALLBACK_TOPIC_SUMMARIES_LIMIT);

    if (summariesErr) t.topicSummariesError = summariesErr.message.slice(0, 60);
    t.topicSummariesCount = summaryRows?.length ?? 0;

    if (!summaryRows || summaryRows.length === 0) return [];

    const nested = await Promise.all(
      summaryRows.map((row) =>
        fetchSummaryFallbackChunksTraced(adminDb, row.id as string, t),
      ),
    );

    return nested.flat();
  } catch (e) {
    t.topicSummariesError = `EXC: ${(e as Error).message.slice(0, 50)}`;
    console.warn("[RAG Chat] Topic fallback fetch failed:", (e as Error).message);
    return [];
  }
}

// --- Fase 3: Coarse-to-Fine result normalizer ---------------------

export function normalizeCoarseToFineResults(
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
