/**
 * routes/ai/chat/context-assembly.ts — Query augmentation & context assembly
 *
 * Extracted from routes/ai/chat.ts during split refactor
 * (refactor/chat-split-modules). Owns the pure (non-DB) helpers that
 * shape the RAG prompt:
 *
 *   - buildAugmentedQuery: Phase 5 history-augmented search query
 *     builder — prepends the last 2 user messages so follow-up
 *     questions ("and its symptoms?") still retrieve relevant chunks.
 *   - assembleContext: Phase 5 smart context assembly — orders
 *     chunks by summary->order_index, deduplicates against primary
 *     matches, and hard-caps output at MAX_CONTEXT_CHARS.
 *
 * Pure extraction — no behavioral change.
 */

import type { MatchedChunk } from "../../../retrieval-strategies.ts";
import type { ContextChunk } from "./types.ts";

// --- Phase 5: History-augmented search query builder ----------------

const MAX_HISTORY_CHARS_FOR_SEARCH = 200;

export function buildAugmentedQuery(
  message: string,
  history: Array<{ role: string; content: string }>,
): { query: string; wasAugmented: boolean } {
  const recentUserMessages = history
    .filter((h) => h.role === "user")
    .slice(-2)
    .map((h) => h.content.slice(0, MAX_HISTORY_CHARS_FOR_SEARCH).trim())
    .filter((s) => s.length > 0);

  if (recentUserMessages.length === 0) {
    return { query: message, wasAugmented: false };
  }

  const augmented = [...recentUserMessages, message].join(" ");
  return { query: augmented, wasAugmented: true };
}

// --- Phase 5: Smart context assembly ------------------------------

const MAX_CONTEXT_CHARS = 8000;

export function assembleContext(
  matches: MatchedChunk[],
  contextChunks: ContextChunk[],
): {
  ragContext: string;
  sourcesUsed: Array<{ chunk_id: string; summary_title: string; similarity: number }>;
  contextChunksCount: number;
} {
  const sourcesUsed = matches.map((m) => ({
    chunk_id: m.chunk_id,
    summary_title: m.summary_title,
    similarity: Math.round(m.similarity * 100) / 100,
  }));

  if (contextChunks.length === 0 && matches.length === 0) {
    return { ragContext: "", sourcesUsed, contextChunksCount: 0 };
  }

  if (contextChunks.length > 0) {
    const titleMap = new Map<string, string>();
    for (const m of matches) {
      titleMap.set(m.summary_id, m.summary_title);
    }

    let context = "";
    let currentSummary = "";
    let charCount = 0;
    let chunksIncluded = 0;

    for (const chunk of contextChunks) {
      if (chunk.summary_id !== currentSummary) {
        const title = titleMap.get(chunk.summary_id) || "Material";
        const header = `\n[De "${title}"]:\n`;
        if (charCount + header.length > MAX_CONTEXT_CHARS) break;
        context += header;
        charCount += header.length;
        currentSummary = chunk.summary_id;
      }

      const separator = chunk.is_primary ? "" : "";
      const text = `${separator}${chunk.content}\n`;
      if (charCount + text.length > MAX_CONTEXT_CHARS) {
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

  const ragContext = "\n\nContexto relevante del material de estudio:\n" +
    matches
      .map((m, i) => `[${i + 1}] (de "${m.summary_title}"): ${m.content}`)
      .join("\n\n");

  return { ragContext, sourcesUsed, contextChunksCount: matches.length };
}
