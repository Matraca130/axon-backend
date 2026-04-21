/**
 * auto-ingest.ts — Automatic chunk + embed pipeline for Axon RAG
 *
 * Pure business-logic function, zero Hono/HTTP dependency.
 * Called by:
 *   - POST /ai/re-chunk  (5.6 — synchronous, professor waits)
 *   - POST/PATCH summary hooks (5.8 — fire-and-forget)
 *   - POST /ai/ingest-pdf (Fase 7 — fire-and-forget)
 *
 * Flow:
 *   1. Fetch summary content from DB
 *   2. Split into chunks via chunker.ts or semantic-chunker.ts
 *   3. Replace existing chunks (DELETE → INSERT)
 *   4. Generate embeddings for each chunk (sequential, rate-limited)
 *   5. Update summaries.last_chunked_at
 *   6. Generate summary-level embedding (Fase 3)
 *
 * Also exports:
 *   - truncateAtWord()       — text utility for safe truncation at word boundary
 *   - embedSummaryContent()  — standalone summary embedding (for batch ingest)
 *
 * Fase 5, sub-task 5.5 — Issue #30
 * Fase 3, sub-tasks 3.2/3.3 — Summary embeddings (Bloque 2)
 * Bloque A: Semantic chunking integration (#23, #24)
 *
 * D57-D62: Embedding migration — generateEmbedding now from openai-embeddings.ts
 *          (OpenAI text-embedding-3-large 1536d). taskType parameter removed.
 */

import {
  chunkMarkdown,
  selectChunkStrategy,
  type ChunkOptions,
  type ChunkResult,
} from "./chunker.ts";
import { chunkSemantic, type SemanticChunkResult } from "./semantic-chunker.ts";
import { generateEmbedding, generateEmbeddings } from "./openai-embeddings.ts";
import { getAdminClient } from "./db.ts";
import { flattenBlocksToMarkdown } from "./block-flatten.ts";
import { advisoryLockKey, withAdvisoryLock } from "./lib/advisory-lock.ts";
import {
  contextualizeChunks,
  type ContextualizeResult,
} from "./contextualizer.ts";
import { crypto } from "https://deno.land/std/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std/encoding/hex.ts";

// Contextual Retrieval feature flag (opt-in).
// OFF by default = zero production impact. Toggle via:
//   supabase secrets set ENABLE_CONTEXTUAL_RETRIEVAL=true
const CONTEXTUAL_RETRIEVAL_ENABLED =
  Deno.env.get("ENABLE_CONTEXTUAL_RETRIEVAL") === "true";
const CONTEXTUAL_CONCURRENCY = 3;

// ─── Public Types ───────────────────────────────────────────────────

export interface AutoIngestResult {
  summary_id: string;
  chunks_created: number;
  embeddings_generated: number;
  embeddings_failed: number;
  retried_count: number;
  strategy_used: string;
  summary_embedded: boolean;
  skipped_unchanged: boolean;
  elapsed_ms: number;
  /** True when contextual retrieval ran on this ingest. */
  contextual_enabled: boolean;
  /** Chunks that fell back to raw content due to LLM failure. 0 when disabled. */
  contextual_fallback_count: number;
}

// ─── Text Utilities ─────────────────────────────────────────────────

export function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cutPoint = text.lastIndexOf(" ", maxChars);
  if (cutPoint <= 0) return text.slice(0, maxChars);
  return text.slice(0, cutPoint);
}

// ─── Content Hash ───────────────────────────────────────────────────

async function computeContentHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hashBuffer));
}

// ─── Summary Embedding ──────────────────────────────────────────────

const SUMMARY_EMBED_MAX_CHARS = 8000;

export async function embedSummaryContent(
  summaryId: string,
  title: string,
  contentMarkdown: string,
): Promise<void> {
  const combined = title.trim().length > 0
    ? `${title.trim()}. ${contentMarkdown}`
    : contentMarkdown;

  const truncated = truncateAtWord(combined, SUMMARY_EMBED_MAX_CHARS);
  const embedding = await generateEmbedding(truncated);

  const { error } = await getAdminClient()
    .from("summaries")
    .update({ embedding: JSON.stringify(embedding) })
    .eq("id", summaryId);

  if (error) {
    throw new Error(
      `[Auto-Ingest] Summary embedding UPDATE failed for ${summaryId}: ${error.message}`,
    );
  }
}

// ─── Retry with Exponential Backoff ─────────────────────────────────

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s

interface RetryResult<T> {
  data: T;
  retries: number;
}

/**
 * Wraps an async operation with exponential backoff retry logic.
 * Only retries on HTTP 429 (rate limit) errors; all other errors fail immediately.
 */
async function withBackoff<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<RetryResult<T>> {
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await fn();
      return { data, retries: attempt };
    } catch (err) {
      lastErr = err as Error;
      const is429 =
        lastErr.message?.includes("429") ||
        lastErr.message?.toLowerCase().includes("rate limit") ||
        (lastErr as unknown as { status?: number }).status === 429;

      if (!is429 || attempt >= MAX_RETRIES) {
        throw lastErr;
      }

      const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempt); // 1s, 2s, 4s
      console.warn(
        `[Auto-Ingest] Rate limited on ${label}, retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastErr!;
}

// ─── Entry Point ────────────────────────────────────────────────────

export async function autoChunkAndEmbed(
  summaryId: string,
  institutionId: string,
  options?: ChunkOptions,
  strategy?: "recursive" | "semantic" | "auto",
): Promise<AutoIngestResult> {
  const t0 = Date.now();
  const adminDb = getAdminClient();
  const lockKey = advisoryLockKey(`auto-ingest:${summaryId}`);

  const result = await withAdvisoryLock(
    adminDb,
    lockKey,
    `auto-ingest:${summaryId}`,
    () => _autoChunkAndEmbedCore(adminDb, summaryId, institutionId, t0, options, strategy),
    () => console.info(`[Auto-Ingest] Skipping summary ${summaryId} — advisory lock not acquired`),
  );

  if (result === null) {
    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      retried_count: 0,
      strategy_used: "skipped_locked",
      summary_embedded: false,
      skipped_unchanged: false,
      elapsed_ms: Date.now() - t0,
      contextual_enabled: false,
      contextual_fallback_count: 0,
    };
  }

  return result;
}

async function _autoChunkAndEmbedCore(
  adminDb: ReturnType<typeof getAdminClient>,
  summaryId: string,
  institutionId: string,
  t0: number,
  options?: ChunkOptions,
  strategy?: "recursive" | "semantic" | "auto",
): Promise<AutoIngestResult> {
  console.info(
    `[Auto-Ingest] Processing summary ${summaryId} (institution: ${institutionId})`,
  );

  // Step 1: Fetch summary content
  const { data: summary, error: fetchErr } = await adminDb
    .from("summaries")
    .select("title, content_markdown")
    .eq("id", summaryId)
    .single();

  if (fetchErr || !summary) {
    throw new Error(
      `[Auto-Ingest] Summary not found: ${summaryId}` +
        (fetchErr ? ` (${fetchErr.message})` : ""),
    );
  }

  // Step 2: Resolve source-of-truth content for chunking.
  //
  // Block-based summaries (Smart Reader) store their canonical
  // content in the summary_blocks table. content_markdown is
  // only populated on explicit publish and goes stale after
  // block edits. We prefer blocks when they exist and fall
  // back to content_markdown for legacy / PDF-ingested summaries.
  const title = (summary.title as string) ?? "";
  const contentMarkdown = (summary.content_markdown as string | null) ?? "";

  let sourceText = "";
  let sourceKind: "blocks" | "content_markdown" | "none" = "none";

  const { data: blockRows, error: blocksErr } = await adminDb
    .from("summary_blocks")
    .select("id, type, content, order_index")
    .eq("summary_id", summaryId)
    .eq("is_active", true)
    .order("order_index", { ascending: true });

  if (blocksErr) {
    console.warn(
      `[Auto-Ingest] Could not fetch blocks for ${summaryId}: ${blocksErr.message}. ` +
        `Falling back to content_markdown.`,
    );
  }

  if (blockRows && blockRows.length > 0) {
    // deno-lint-ignore no-explicit-any
    const flattened = flattenBlocksToMarkdown(blockRows as any);
    if (flattened.trim().length > 0) {
      sourceText = flattened;
      sourceKind = "blocks";
    }
  }

  if (sourceKind === "none" && contentMarkdown.trim().length > 0) {
    sourceText = contentMarkdown;
    sourceKind = "content_markdown";
  }

  if (sourceKind === "none") {
    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      retried_count: 0,
      strategy_used: "none",
      summary_embedded: false,
      skipped_unchanged: false,
      elapsed_ms: Date.now() - t0,
      contextual_enabled: false,
      contextual_fallback_count: 0,
    };
  }

  // Step 2b: Content hash check — skip re-chunking if content hasn't changed
  const fullText = title.trim().length > 0
    ? `${title}\n\n${sourceText}`
    : sourceText;

  const newContentHash = await computeContentHash(fullText);

  const { data: existingChunk } = await adminDb
    .from("chunks")
    .select("content_hash")
    .eq("summary_id", summaryId)
    .limit(1)
    .single();

  if (existingChunk?.content_hash && existingChunk.content_hash === newContentHash) {
    console.info(
      `[Auto-Ingest] Skipping ${summaryId} — content hash unchanged (${newContentHash.slice(0, 8)}...)`,
    );
    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      retried_count: 0,
      strategy_used: "skipped_unchanged",
      summary_embedded: false,
      skipped_unchanged: true,
      elapsed_ms: Date.now() - t0,
      contextual_enabled: false,
      contextual_fallback_count: 0,
    };
  }

  // Step 3a: Select strategy (D41, D42)
  const selectedStrategy = selectChunkStrategy(
    fullText,
    strategy === "auto" || !strategy ? undefined : strategy,
  );

  // Step 3b: Execute chosen strategy
  let chunks: ChunkResult[];
  // Paragraph embeddings from semantic chunker — reused to skip re-embedding
  let paragraphEmbeddings: Map<string, number[]> = new Map();

  if (selectedStrategy === "semantic") {
    // D57: embedFn no longer needs taskType
    const embedFn = (text: string) => generateEmbedding(text);
    const semanticResult: SemanticChunkResult = await chunkSemantic(fullText, embedFn, options);
    chunks = semanticResult.chunks;
    paragraphEmbeddings = semanticResult.paragraphEmbeddings;
  } else {
    chunks = chunkMarkdown(fullText, options);
  }

  if (chunks.length === 0) {
    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      retried_count: 0,
      strategy_used: "none",
      summary_embedded: false,
      skipped_unchanged: false,
      elapsed_ms: Date.now() - t0,
      contextual_enabled: false,
      contextual_fallback_count: 0,
    };
  }

  // Step 3c: Contextual Retrieval (opt-in). When enabled, each chunk gets a
  // 1-2 sentence prefix from Haiku 4.5 situating it within the full document.
  // Anthropic prompt-caches the document block so we pay it once per summary
  // rather than once per chunk. Failures per-chunk fall back silently to
  // raw content + model="fallback-plain" — never throws.
  let contextualResults: ContextualizeResult[] | null = null;
  let contextualFallbackCount = 0;

  if (CONTEXTUAL_RETRIEVAL_ENABLED) {
    try {
      contextualResults = await contextualizeChunks(
        fullText,
        title,
        chunks.map((c) => c.content),
        CONTEXTUAL_CONCURRENCY,
      );
      contextualFallbackCount = contextualResults.filter((r) => r.fellBack).length;
      if (contextualFallbackCount > 0) {
        console.warn(
          `[Auto-Ingest] Contextual fallback on ${contextualFallbackCount}/${chunks.length} ` +
            `chunks for ${summaryId} — embeddings will use raw content for those.`,
        );
      } else {
        console.info(
          `[Auto-Ingest] Contextualized ${chunks.length} chunks for ${summaryId}`,
        );
      }
    } catch (e) {
      // contextualizeChunks is supposed to never throw, but guard anyway
      // so an unexpected bug in the contextualizer can't break ingest.
      console.warn(
        `[Auto-Ingest] Contextualization threw unexpectedly, skipping for ${summaryId}: ` +
          (e as Error).message,
      );
      contextualResults = null;
    }
  }

  // Step 4: Delete existing chunks
  const { error: deleteErr } = await adminDb
    .from("chunks")
    .delete()
    .eq("summary_id", summaryId);

  if (deleteErr) {
    throw new Error(
      `[Auto-Ingest] Failed to delete old chunks for ${summaryId}: ${deleteErr.message}`,
    );
  }

  // Step 5: Insert new chunks (with content_hash for change detection).
  // When contextual retrieval ran, we also persist contextual_content +
  // contextual_model here. contextual_embedding is UPDATEd later alongside
  // the raw embedding so both columns land in a single round trip per chunk.
  const insertData = chunks.map((chunk, i) => {
    const base: Record<string, unknown> = {
      summary_id: summaryId,
      content: chunk.content,
      order_index: chunk.order_index,
      chunk_strategy: chunk.strategy,
      content_hash: newContentHash,
    };
    if (contextualResults) {
      base.contextual_content = contextualResults[i].contextualContent;
      base.contextual_model = contextualResults[i].model;
    }
    return base;
  });

  const { data: inserted, error: insertErr } = await adminDb
    .from("chunks")
    .insert(insertData)
    .select("id");

  if (insertErr || !inserted) {
    throw new Error(
      `[Auto-Ingest] Failed to insert chunks for ${summaryId}: ` +
        (insertErr?.message ?? "no data returned"),
    );
  }

  // Step 6: Mark summary as chunked
  const { error: updateTsErr } = await adminDb
    .from("summaries")
    .update({ last_chunked_at: new Date().toISOString() })
    .eq("id", summaryId);

  if (updateTsErr) {
    console.warn(
      `[Auto-Ingest] Failed to update last_chunked_at for ${summaryId}: ` +
        updateTsErr.message,
    );
  }

  // Step 7: Generate chunk embeddings (batch, with sequential fallback)
  let generated = 0;
  let failed = 0;

  // 7a: Generate contextual embeddings up front (when contextual retrieval ran).
  // These are independent of the raw-embedding flow. If this batch call fails,
  // we log and carry on with NULL contextual_embedding — raw embeddings still
  // get written, chunks remain searchable via the existing embedding column.
  let contextualEmbeddings: number[][] | null = null;
  if (contextualResults) {
    try {
      contextualEmbeddings = await generateEmbeddings(
        contextualResults.map((r) => r.contextualContent),
      );
    } catch (e) {
      console.warn(
        `[Auto-Ingest] Contextual embedding batch failed for ${summaryId}, ` +
          `leaving contextual_embedding NULL: ${(e as Error).message}`,
      );
      contextualEmbeddings = null;
    }
  }

  try {
    // Task 4.8: Reuse semantic chunker embeddings where chunk matches a paragraph
    const reusedEmbeddings: (number[] | null)[] = chunks.map((chunk) => {
      if (paragraphEmbeddings.size > 0) {
        const cached = paragraphEmbeddings.get(chunk.content);
        if (cached) return cached;
      }
      return null;
    });

    // Only call OpenAI for chunks that don't have a reusable embedding
    const textsToEmbed: string[] = [];
    const embedIndices: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (!reusedEmbeddings[i]) {
        textsToEmbed.push(chunks[i].content);
        embedIndices.push(i);
      }
    }

    let newEmbeddings: number[][] = [];
    if (textsToEmbed.length > 0) {
      // Call generateEmbeddings directly — it already has internal 3-retry
      // backoff in openai-embeddings.ts; wrapping with withBackoff would
      // cause up to 4×3 = 12 retries on 429s.
      newEmbeddings = await generateEmbeddings(textsToEmbed);
    }

    // Merge reused and newly generated embeddings
    const allEmbeddings: number[][] = new Array(chunks.length);
    let newIdx = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (reusedEmbeddings[i]) {
        allEmbeddings[i] = reusedEmbeddings[i]!;
      } else {
        allEmbeddings[i] = newEmbeddings[newIdx++];
      }
    }

    const reusedCount = chunks.length - textsToEmbed.length;
    if (reusedCount > 0) {
      console.info(
        `[Auto-Ingest] Reused ${reusedCount}/${chunks.length} embeddings from semantic chunker`,
      );
    }

    for (let i = 0; i < inserted.length; i++) {
      const updatePayload: Record<string, unknown> = {
        embedding: JSON.stringify(allEmbeddings[i]),
      };
      if (contextualEmbeddings) {
        updatePayload.contextual_embedding = JSON.stringify(contextualEmbeddings[i]);
      }
      const { error: embedErr } = await adminDb
        .from("chunks")
        .update(updatePayload)
        .eq("id", inserted[i].id);

      if (embedErr) {
        failed++;
        console.warn(
          `[Auto-Ingest] Embedding UPDATE failed for chunk ${inserted[i].id}: ` +
            embedErr.message,
        );
      } else {
        generated++;
      }
    }
  } catch (batchErr) {
    // Fallback: sequential embedding on batch failure (with per-chunk backoff)
    console.warn(
      `[Auto-Ingest] Batch embedding failed, falling back to sequential: ${(batchErr as Error).message}`,
    );

    for (let i = 0; i < inserted.length; i++) {
      try {
        // Call generateEmbedding directly — internal retry in
        // openai-embeddings.ts already handles 429/503.
        const embedding = await generateEmbedding(chunks[i].content);

        const updatePayload: Record<string, unknown> = {
          embedding: JSON.stringify(embedding),
        };
        if (contextualEmbeddings) {
          updatePayload.contextual_embedding = JSON.stringify(contextualEmbeddings[i]);
        }
        const { error: embedErr } = await adminDb
          .from("chunks")
          .update(updatePayload)
          .eq("id", inserted[i].id);

        if (embedErr) {
          failed++;
          console.warn(
            `[Auto-Ingest] Embedding UPDATE failed for chunk ${inserted[i].id}: ` +
              embedErr.message,
          );
        } else {
          generated++;
        }

        if (generated > 0 && generated % 10 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (e) {
        failed++;
        console.warn(
          `[Auto-Ingest] Embedding generation failed for chunk ${i}/${inserted.length} ` +
            `(id: ${inserted[i].id}): ${(e as Error).message}`,
        );
      }
    }
  }

  // Step 8: Generate summary-level embedding
  //
  // Use the resolved source text (blocks-flattened or content_markdown)
  // so block-based summaries get fresh summary embeddings too.
  let summaryEmbedded = false;

  try {
    await embedSummaryContent(summaryId, title, sourceText);
    summaryEmbedded = true;
  } catch (e) {
    console.warn(
      `[Auto-Ingest] Summary embedding failed for ${summaryId}: ` +
        (e as Error).message,
    );
  }

  // Step 9: Return result
  const elapsed = Date.now() - t0;

  console.info(
    `[Auto-Ingest] Done: ${summaryId} — ${chunks.length} chunks (${selectedStrategy}, source=${sourceKind}), ` +
      `${generated} embedded, ${failed} failed, ` +
      `summary_embed=${summaryEmbedded}, ` +
      `contextual=${contextualResults ? `on(fallbacks=${contextualFallbackCount})` : "off"}, ` +
      `${elapsed}ms`,
  );

  return {
    summary_id: summaryId,
    chunks_created: chunks.length,
    embeddings_generated: generated,
    embeddings_failed: failed,
    retried_count: 0,
    strategy_used: chunks[0]?.strategy ?? "recursive",
    summary_embedded: summaryEmbedded,
    skipped_unchanged: false,
    elapsed_ms: elapsed,
    contextual_enabled: contextualResults !== null,
    contextual_fallback_count: contextualFallbackCount,
  };
}
