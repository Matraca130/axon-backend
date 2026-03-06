/**
 * auto-ingest.ts — Automatic chunking + embedding pipeline
 *
 * Given a summary ID, this module:
 *   1. Fetches the summary's content_markdown
 *   2. Chunks it using chunker.ts (recursive splitting)
 *   3. Deletes existing chunks for that summary
 *   4. Inserts new chunks with order_index + chunk_strategy
 *   5. Generates embeddings for each chunk (with rate limiting)
 *   6. Updates summaries.last_chunked_at
 *
 * Used by:
 *   - POST /ai/re-chunk (manual trigger)
 *   - Summary create/update hooks (fire-and-forget)
 *
 * Fase 5 — Issue #30, sub-task 5.5
 */

import { chunkMarkdown, type ChunkOptions } from "./chunker.ts";
import { generateEmbedding } from "./gemini.ts";
import { getAdminClient } from "./db.ts";

// ─── Types ──────────────────────────────────────────────────────

export interface AutoIngestResult {
  summary_id: string;
  chunks_created: number;
  embeddings_generated: number;
  embeddings_failed: number;
  strategy_used: string;
  elapsed_ms: number;
}

// ─── Constants ───────────────────────────────────────────────────

// Pause 1 second every 10 embeddings to avoid Gemini rate limits
const EMBED_BATCH_SIZE = 10;
const EMBED_PAUSE_MS = 1000;

// ─── Main function ──────────────────────────────────────────────

/**
 * Chunk a summary's markdown content and generate embeddings.
 *
 * This function is designed to be called fire-and-forget from
 * route handlers. It uses the admin client to bypass RLS.
 *
 * @param summaryId      - UUID of the summary to process
 * @param _institutionId - Institution UUID (reserved for future use)
 * @param options        - Optional chunking parameters override
 * @returns AutoIngestResult with processing metrics
 */
export async function autoChunkAndEmbed(
  summaryId: string,
  _institutionId: string,
  options?: ChunkOptions,
): Promise<AutoIngestResult> {
  const t0 = Date.now();
  const adminDb = getAdminClient();

  // 1. Fetch summary content
  const { data: summary, error: fetchErr } = await adminDb
    .from("summaries")
    .select("content_markdown, title")
    .eq("id", summaryId)
    .single();

  if (fetchErr || !summary) {
    throw new Error(`Summary not found: ${summaryId}`);
  }

  // Guard: no content to chunk
  if (!summary.content_markdown || summary.content_markdown.trim().length === 0) {
    // Update last_chunked_at even if no content (marks as processed)
    await adminDb
      .from("summaries")
      .update({ last_chunked_at: new Date().toISOString() })
      .eq("id", summaryId);

    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      strategy_used: "none",
      elapsed_ms: Date.now() - t0,
    };
  }

  // 2. Chunk the markdown (prepend title for context)
  const content = summary.title
    ? `${summary.title}\n\n${summary.content_markdown}`
    : summary.content_markdown;

  const chunks = chunkMarkdown(content, options);

  if (chunks.length === 0) {
    await adminDb
      .from("summaries")
      .update({ last_chunked_at: new Date().toISOString() })
      .eq("id", summaryId);

    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      strategy_used: "none",
      elapsed_ms: Date.now() - t0,
    };
  }

  // 3. Delete existing chunks (re-chunk = replace)
  const { error: delErr } = await adminDb
    .from("chunks")
    .delete()
    .eq("summary_id", summaryId);

  if (delErr) {
    throw new Error(`Failed to delete existing chunks: ${delErr.message}`);
  }

  // 4. Insert new chunks
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

  if (insertErr) {
    throw new Error(`Chunk insert failed: ${insertErr.message}`);
  }

  // 5. Generate embeddings (with rate limiting)
  let generated = 0;
  let failed = 0;

  for (let i = 0; i < (inserted || []).length; i++) {
    const row = inserted![i];
    const chunkContent = chunks[i]?.content;
    if (!chunkContent) continue;

    try {
      const embedding = await generateEmbedding(
        chunkContent,
        "RETRIEVAL_DOCUMENT",
      );

      const { error: updateErr } = await adminDb
        .from("chunks")
        .update({ embedding: JSON.stringify(embedding) })
        .eq("id", row.id);

      if (updateErr) {
        console.warn(`[Auto-Ingest] Embedding update failed for chunk ${row.id}:`, updateErr.message);
        failed++;
      } else {
        generated++;
      }

      // Rate limit: pause every EMBED_BATCH_SIZE embeddings
      if (generated > 0 && generated % EMBED_BATCH_SIZE === 0) {
        await new Promise((r) => setTimeout(r, EMBED_PAUSE_MS));
      }
    } catch (e) {
      console.warn(`[Auto-Ingest] Embedding failed for chunk ${row.id}:`, (e as Error).message);
      failed++;
    }
  }

  // 6. Update last_chunked_at
  await adminDb
    .from("summaries")
    .update({ last_chunked_at: new Date().toISOString() })
    .eq("id", summaryId);

  return {
    summary_id: summaryId,
    chunks_created: chunks.length,
    embeddings_generated: generated,
    embeddings_failed: failed,
    strategy_used: chunks[0]?.strategy || "recursive",
    elapsed_ms: Date.now() - t0,
  };
}
