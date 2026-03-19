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
import { chunkSemantic } from "./semantic-chunker.ts";
import { generateEmbedding, generateEmbeddings } from "./openai-embeddings.ts";
import { getAdminClient } from "./db.ts";

// ─── Public Types ───────────────────────────────────────────────────

export interface AutoIngestResult {
  summary_id: string;
  chunks_created: number;
  embeddings_generated: number;
  embeddings_failed: number;
  strategy_used: string;
  summary_embedded: boolean;
  elapsed_ms: number;
}

// ─── Text Utilities ─────────────────────────────────────────────────

export function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cutPoint = text.lastIndexOf(" ", maxChars);
  if (cutPoint <= 0) return text.slice(0, maxChars);
  return text.slice(0, cutPoint);
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

// ─── Advisory Lock ──────────────────────────────────────────────────

/**
 * Compute a stable advisory lock key from a UUID string.
 * pg_try_advisory_lock uses bigint; we hash the summaryId to get a
 * deterministic 32-bit integer (safe for advisory lock).
 */
function advisoryLockKey(summaryId: string): number {
  let hash = 0;
  for (let i = 0; i < summaryId.length; i++) {
    hash = ((hash << 5) - hash + summaryId.charCodeAt(i)) | 0;
  }
  return hash;
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
  const lockKey = advisoryLockKey(summaryId);

  // Acquire advisory lock to prevent concurrent ingest of the same summary
  const { data: lockAcquired } = await adminDb.rpc("try_advisory_lock", {
    lock_key: lockKey,
  });

  if (!lockAcquired) {
    console.info(
      `[Auto-Ingest] Skipping summary ${summaryId} — advisory lock not acquired`,
    );
    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      strategy_used: "skipped_locked",
      summary_embedded: false,
      elapsed_ms: Date.now() - t0,
    };
  }

  try {
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

  // Step 2: Guard empty content
  const contentMarkdown = summary.content_markdown as string | null;

  if (!contentMarkdown || contentMarkdown.trim().length === 0) {
    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      strategy_used: "none",
      summary_embedded: false,
      elapsed_ms: Date.now() - t0,
    };
  }

  // Step 3: Chunk the markdown
  const title = (summary.title as string) ?? "";
  const fullText = title.trim().length > 0
    ? `${title}\n\n${contentMarkdown}`
    : contentMarkdown;

  // Step 3a: Select strategy (D41, D42)
  const selectedStrategy = selectChunkStrategy(
    fullText,
    strategy === "auto" || !strategy ? undefined : strategy,
  );

  // Step 3b: Execute chosen strategy
  let chunks: ChunkResult[];

  if (selectedStrategy === "semantic") {
    // D57: embedFn no longer needs taskType
    const embedFn = (text: string) => generateEmbedding(text);
    chunks = await chunkSemantic(fullText, embedFn, options);
  } else {
    chunks = chunkMarkdown(fullText, options);
  }

  if (chunks.length === 0) {
    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      strategy_used: "none",
      summary_embedded: false,
      elapsed_ms: Date.now() - t0,
    };
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

  // Step 5: Insert new chunks
  const insertData = chunks.map((chunk) => ({
    summary_id: summaryId,
    content: chunk.content,
    order_index: chunk.order_index,
    chunk_strategy: chunk.strategy,
  }));

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

  try {
    // Task 4.1: Batch embeddings — single API call for all chunks
    const chunkTexts = chunks.map((chunk) => chunk.content);
    const allEmbeddings = await generateEmbeddings(chunkTexts);

    for (let i = 0; i < inserted.length; i++) {
      const { error: embedErr } = await adminDb
        .from("chunks")
        .update({ embedding: JSON.stringify(allEmbeddings[i]) })
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
    // Fallback: sequential embedding on batch failure
    console.warn(
      `[Auto-Ingest] Batch embedding failed, falling back to sequential: ${(batchErr as Error).message}`,
    );

    for (let i = 0; i < inserted.length; i++) {
      try {
        const embedding = await generateEmbedding(chunks[i].content);

        const { error: embedErr } = await adminDb
          .from("chunks")
          .update({ embedding: JSON.stringify(embedding) })
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
          `[Auto-Ingest] Embedding generation failed for chunk ${inserted[i].id}: ` +
            (e as Error).message,
        );
      }
    }
  }

  // Step 8: Generate summary-level embedding
  let summaryEmbedded = false;

  try {
    await embedSummaryContent(summaryId, title, contentMarkdown);
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
    `[Auto-Ingest] Done: ${summaryId} — ${chunks.length} chunks (${selectedStrategy}), ` +
      `${generated} embedded, ${failed} failed, ` +
      `summary_embed=${summaryEmbedded}, ${elapsed}ms`,
  );

  return {
    summary_id: summaryId,
    chunks_created: chunks.length,
    embeddings_generated: generated,
    embeddings_failed: failed,
    strategy_used: chunks[0]?.strategy ?? "recursive",
    summary_embedded: summaryEmbedded,
    elapsed_ms: elapsed,
  };

  } finally {
    // Release advisory lock
    await adminDb.rpc("advisory_unlock", { lock_key: lockKey }).catch((e: Error) => {
      console.warn(`[Auto-Ingest] Failed to release advisory lock for ${summaryId}:`, e.message);
    });
  }
}
