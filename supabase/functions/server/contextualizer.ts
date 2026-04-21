/**
 * contextualizer.ts — Anthropic Contextual Retrieval for Axon RAG
 *
 * Reference: https://www.anthropic.com/news/contextual-retrieval
 *
 * For each chunk we ask Haiku 4.5 for a 1-2 sentence prefix that
 * situates the chunk inside its parent summary. The result gets
 * prepended to the chunk before embedding, improving retrieval
 * recall on queries that don't literally overlap with chunk text.
 *
 * Prompt caching (cache_control: ephemeral) is critical to the cost
 * model: the full summary markdown sits in the system block and is
 * cached between calls for the same summary, so we pay the input
 * tokens once per summary instead of once per chunk (~20x savings
 * at 20 chunks/summary).
 *
 * This file does NOT use the generateText() wrapper in claude-ai.ts
 * because that wrapper doesn't expose the system-blocks / cache_control
 * shape needed for prompt caching. We call Anthropic directly with
 * the same auth + retry primitives used elsewhere in the codebase.
 *
 * Failure policy: NEVER throw. A Haiku failure falls back to the raw
 * chunk content + model="fallback-plain", so the upstream caller keeps
 * a stable contract. Callers should count fallback-plain occurrences
 * and alert if they exceed a small percentage.
 */

import { getClaudeApiKey, fetchWithRetry, getModelId } from "./claude-ai.ts";

// ─── Constants ─────────────────────────────────────────────────────

const CLAUDE_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const CONTEXTUALIZE_TIMEOUT_MS = 20_000;
const HAIKU_MODEL_ID = getModelId("haiku"); // claude-haiku-4-5-20251001
const FALLBACK_MODEL = "fallback-plain";

// Target: 1-2 sentences, <= ~40 words. ~80 tokens is a generous cap.
const MAX_OUTPUT_TOKENS = 120;

// Cap document size fed to cache to ~180k chars (~45k tokens), well below
// Anthropic's 200k context. Very long summaries get truncated at word boundary.
const MAX_DOCUMENT_CHARS = 180_000;

// ─── Types ─────────────────────────────────────────────────────────

export interface ContextualizeResult {
  /** Contextualized text to embed: "<context sentence>. <original chunk>" */
  contextualContent: string;
  /** Model ID on success, or "fallback-plain" if LLM call failed. */
  model: string;
  /** True when the LLM call did not succeed and we emitted fallback text. */
  fellBack: boolean;
}

export interface ChunkPosition {
  /** 0-based index of this chunk within its summary. */
  index: number;
  /** Total number of chunks in the summary. */
  total: number;
}

// ─── Prompt construction ───────────────────────────────────────────

const CONTEXT_SYSTEM_INSTRUCTION =
  "You generate short contextual prefixes for chunks of a larger educational " +
  "document so they can be retrieved more accurately by a vector search system. " +
  "Respond ONLY with 1-2 sentences (max 40 words) situating the chunk in the " +
  "document — no preamble, no labels, no quotes, no trailing punctuation beyond " +
  "the final period. Match the language of the document.";

function buildUserPrompt(
  chunkContent: string,
  position: ChunkPosition,
  summaryTitle: string,
): string {
  // Chunk position hint helps Haiku pick the right part of the document.
  const positionHint = `Chunk ${position.index + 1} of ${position.total}`;
  const titleHint = summaryTitle.trim().length > 0
    ? `Document title: ${summaryTitle.trim()}`
    : "";

  return [
    titleHint,
    positionHint,
    "",
    "<chunk>",
    chunkContent,
    "</chunk>",
    "",
    "Write 1-2 short sentences that situate this chunk inside the document, " +
      "in the same language as the document. Output ONLY the sentences.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function truncateDocument(documentMarkdown: string): string {
  if (documentMarkdown.length <= MAX_DOCUMENT_CHARS) return documentMarkdown;
  const cut = documentMarkdown.lastIndexOf(" ", MAX_DOCUMENT_CHARS);
  return documentMarkdown.slice(0, cut > 0 ? cut : MAX_DOCUMENT_CHARS);
}

function sanitizeContextOutput(raw: string): string {
  // Collapse whitespace, strip surrounding quotes, enforce a hard length cap.
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const unquoted = collapsed.replace(/^["'`](.*)["'`]$/, "$1").trim();
  // Hard cap at 400 chars so a runaway response can't blow up embedding input.
  return unquoted.length > 400 ? unquoted.slice(0, 400).trimEnd() : unquoted;
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Produce a contextualized version of `chunkContent` for embedding.
 *
 * The returned `contextualContent` is safe to pass to generateEmbedding():
 *   - On success, it's "<llm context>\n\n<original chunk>".
 *   - On failure, it's exactly `chunkContent` (same string identity not guaranteed).
 *
 * Never throws. Callers should track `fellBack` to monitor LLM health.
 */
export async function contextualizeChunk(
  summaryMarkdown: string,
  summaryTitle: string,
  chunkContent: string,
  position: ChunkPosition,
): Promise<ContextualizeResult> {
  // Defensive: empty chunk → nothing to contextualize.
  if (!chunkContent || chunkContent.trim().length === 0) {
    return {
      contextualContent: chunkContent,
      model: FALLBACK_MODEL,
      fellBack: true,
    };
  }

  let apiKey: string;
  try {
    apiKey = getClaudeApiKey();
  } catch (e) {
    console.warn(
      `[Contextualizer] Missing ANTHROPIC_API_KEY, falling back to raw chunk: ${(e as Error).message}`,
    );
    return {
      contextualContent: chunkContent,
      model: FALLBACK_MODEL,
      fellBack: true,
    };
  }

  const documentText = truncateDocument(summaryMarkdown);
  const userPrompt = buildUserPrompt(chunkContent, position, summaryTitle);

  // system is an array of content blocks so we can attach cache_control.
  // Anthropic caches the system prefix across calls with identical content
  // (same summary markdown), so subsequent chunks of the same summary only
  // pay the short user prompt in full. First call primes the cache.
  const body = {
    model: HAIKU_MODEL_ID,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    system: [
      {
        type: "text",
        text: CONTEXT_SYSTEM_INSTRUCTION,
      },
      {
        type: "text",
        text: `<document>\n${documentText}\n</document>`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userPrompt }],
  };

  try {
    const res = await fetchWithRetry(
      `${CLAUDE_BASE}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      },
      CONTEXTUALIZE_TIMEOUT_MS,
      3,
    );

    if (!res.ok) {
      const errText = await res.text();
      console.warn(
        `[Contextualizer] Claude ${res.status}: ${errText.slice(0, 200)}`,
      );
      return {
        contextualContent: chunkContent,
        model: FALLBACK_MODEL,
        fellBack: true,
      };
    }

    const data = await res.json();
    const textBlock = data.content?.find(
      (b: { type: string }) => b.type === "text",
    );
    const rawText = textBlock?.text as string | undefined;

    if (!rawText || rawText.trim().length === 0) {
      console.warn("[Contextualizer] Claude returned empty content");
      return {
        contextualContent: chunkContent,
        model: FALLBACK_MODEL,
        fellBack: true,
      };
    }

    const context = sanitizeContextOutput(rawText);

    // Guard: a pathological one-char output isn't useful. Treat as fallback.
    if (context.length < 4) {
      return {
        contextualContent: chunkContent,
        model: FALLBACK_MODEL,
        fellBack: true,
      };
    }

    return {
      contextualContent: `${context}\n\n${chunkContent}`,
      model: HAIKU_MODEL_ID,
      fellBack: false,
    };
  } catch (e) {
    console.warn(
      `[Contextualizer] Unexpected error, falling back: ${(e as Error).message}`,
    );
    return {
      contextualContent: chunkContent,
      model: FALLBACK_MODEL,
      fellBack: true,
    };
  }
}

/**
 * Batch variant with bounded concurrency. Preserves input order.
 * Never throws — per-item failures surface as `fellBack: true` in-place.
 */
export async function contextualizeChunks(
  summaryMarkdown: string,
  summaryTitle: string,
  chunks: string[],
  concurrency = 3,
): Promise<ContextualizeResult[]> {
  const total = chunks.length;
  const results = new Array<ContextualizeResult>(total);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      results[i] = await contextualizeChunk(
        summaryMarkdown,
        summaryTitle,
        chunks[i],
        { index: i, total },
      );
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, total) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/** Exposed for tests and metrics. */
export const CONTEXTUALIZER_FALLBACK_MODEL = FALLBACK_MODEL;
export const CONTEXTUALIZER_MODEL_ID = HAIKU_MODEL_ID;
