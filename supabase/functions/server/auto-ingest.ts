/**
 * auto-ingest.ts — Automatic chunk + embed pipeline for Axon RAG
 *
 * Pure business-logic function, zero Hono/HTTP dependency.
 * Called by:
 *   - POST /ai/re-chunk  (5.6 — synchronous, professor waits)
 *   - POST/PATCH summary hooks (5.8 — fire-and-forget, future)
 *
 * Flow:
 *   1. Fetch summary content from DB
 *   2. Split into chunks via chunker.ts
 *   3. Replace existing chunks (DELETE → INSERT)
 *   4. Generate embeddings for each chunk (sequential, rate-limited)
 *   5. Update summaries.last_chunked_at
 *
 * Error strategy:
 *   - Throws on fatal errors (summary not found, INSERT failed)
 *   - Absorbs embedding failures → returns embeddings_failed count
 *   - Caller decides whether to throw or log
 *
 * Fase 5, sub-task 5.5 — Issue #30
 */

import { chunkMarkdown, type ChunkOptions } from "./chunker.ts";
import { generateEmbedding } from "./gemini.ts";
import { getAdminClient } from "./db.ts";

// ─── Public Types ───────────────────────────────────────────────────

export interface AutoIngestResult {
  /** The summary that was processed */
  summary_id: string;
  /** Number of chunks created by the chunker */
  chunks_created: number;
  /** Number of chunks that received an embedding successfully */
  embeddings_generated: number;
  /** Number of chunks where embedding generation failed */
  embeddings_failed: number;
  /** Chunking strategy used (from ChunkResult.strategy) */
  strategy_used: string;
  /** Total wall-clock time in milliseconds */
  elapsed_ms: number;
}

// ─── Entry Point ────────────────────────────────────────────────────

/**
 * Chunk a summary's markdown content and generate embeddings.
 *
 * This function TRUSTS its inputs — auth and institution-scoping
 * must be validated by the caller (route handler or hook).
 *
 * @param summaryId      UUID of the summary to process
 * @param institutionId  UUID of the institution (used for logging context)
 * @param options        Optional chunking parameter overrides
 * @returns              Stats about the operation
 * @throws              If summary not found or chunk INSERT fails
 *
 * @example
 *   // From a route handler (synchronous):
 *   const result = await autoChunkAndEmbed(summaryId, institutionId);
 *   return ok(c, result);
 *
 *   // From a summary hook (fire-and-forget):
 *   autoChunkAndEmbed(summaryId, institutionId)
 *     .then(r => console.log(`[Auto-Ingest] ${r.chunks_created} chunks`))
 *     .catch(e => console.error(`[Auto-Ingest] Failed:`, e.message));
 */
export async function autoChunkAndEmbed(
  summaryId: string,
  institutionId: string,
  options?: ChunkOptions,
): Promise<AutoIngestResult> {
  const t0 = Date.now();
  const adminDb = getAdminClient();

  // R1-I1 FIX: Log entry with institutionId for operational debugging.
  // Previously the parameter was declared but never referenced.
  console.info(
    `[Auto-Ingest] Processing summary ${summaryId} (institution: ${institutionId})`,
  );

  // ── Step 1: Fetch summary content ─────────────────────────────

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

  // ── Step 2: Guard — empty content (non-destructive) ───────────
  //
  // If content_markdown is null/empty/whitespace, return early
  // WITHOUT deleting existing chunks. The professor may be
  // mid-edit; destroying chunks + embeddings would be wasteful.

  const contentMarkdown = summary.content_markdown as string | null;

  if (!contentMarkdown || contentMarkdown.trim().length === 0) {
    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      strategy_used: "none",
      elapsed_ms: Date.now() - t0,
    };
  }

  // ── Step 3: Chunk the markdown ────────────────────────────────
  //
  // Prepend the summary title so the first chunk contains it.
  // This improves retrieval: the title provides topic context
  // that pure content paragraphs lack.

  const title = (summary.title as string) ?? "";
  const fullText = title.trim().length > 0
    ? `${title}\n\n${contentMarkdown}`
    : contentMarkdown;

  const chunks = chunkMarkdown(fullText, options);

  // Edge case: chunker returned 0 chunks (shouldn't happen with
  // non-empty input, but guard defensively)
  if (chunks.length === 0) {
    return {
      summary_id: summaryId,
      chunks_created: 0,
      embeddings_generated: 0,
      embeddings_failed: 0,
      strategy_used: "none",
      elapsed_ms: Date.now() - t0,
    };
  }

  // ── Step 4: Delete existing chunks ────────────────────────────
  //
  // DELETE → INSERT (not UPSERT) because chunks have no stable
  // identity across re-chunkings. order_index and content both
  // change when the source markdown changes.
  //
  // Risk: if INSERT fails after DELETE, the summary has 0 chunks
  // temporarily. Mitigated by: last_chunked_at stays at its
  // previous value until Step 6 succeeds, so the system knows
  // the summary needs re-processing.

  const { error: deleteErr } = await adminDb
    .from("chunks")
    .delete()
    .eq("summary_id", summaryId);

  if (deleteErr) {
    throw new Error(
      `[Auto-Ingest] Failed to delete old chunks for ${summaryId}: ${deleteErr.message}`,
    );
  }

  // ── Step 5: Insert new chunks ─────────────────────────────────
  //
  // chunk_strategy is set EXPLICITLY from ChunkResult.strategy
  // (not relying on the DB DEFAULT). This is self-documenting
  // and will propagate correctly when Fase 8 adds "semantic".

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

  // ── Step 6: Mark summary as chunked ───────────────────────────
  //
  // Set AFTER insert succeeds, BEFORE embedding generation.
  //
  // Why before embeddings?
  //   If embeddings fail (Gemini 429, timeout), the chunks still
  //   exist in DB. Setting last_chunked_at prevents unnecessary
  //   re-chunking on retry. Missing embeddings are filled by
  //   POST /ai/ingest-embeddings (which finds chunks with
  //   embedding IS NULL).
  //
  // Why not before insert?
  //   If insert fails, we'd have marked it as chunked when it
  //   wasn't — a lie that prevents retry.

  const { error: updateTsErr } = await adminDb
    .from("summaries")
    .update({ last_chunked_at: new Date().toISOString() })
    .eq("id", summaryId);

  if (updateTsErr) {
    // Non-fatal: chunks are inserted, just the timestamp is stale.
    // Log but don't throw — the chunks are the important part.
    console.warn(
      `[Auto-Ingest] Failed to update last_chunked_at for ${summaryId}: ` +
        updateTsErr.message,
    );
  }

  // ── Step 7: Generate embeddings (sequential, rate-limited) ────
  //
  // Sequential loop with 1s pause every 10 embeddings.
  // Consistent with ingest.ts pattern.
  //
  // Why sequential?
  //   - Typical summary = 3-8 chunks → ~3-8 seconds total
  //   - Gemini free tier: 1500 RPM embed (shared across users)
  //   - Parallel would be ~1s faster but risks 429 under load
  //   - Sequential + pause is battle-tested in ingest.ts
  //
  // Why absorb errors?
  //   - One failed embedding shouldn't abort the whole batch
  //   - Caller gets embeddings_failed count to decide next action
  //   - POST /ai/ingest-embeddings can fill gaps later

  let generated = 0;
  let failed = 0;

  for (let i = 0; i < inserted.length; i++) {
    try {
      const embedding = await generateEmbedding(
        chunks[i].content,
        "RETRIEVAL_DOCUMENT",
      );

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

      // Rate limit: 1s pause every 10 successful embeddings
      // Prevents hitting Gemini's RPM limit during bulk operations
      // Guard: generated > 0 avoids spurious pause when 0 % 10 === 0
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

  // ── Step 8: Return result ─────────────────────────────────────

  const elapsed = Date.now() - t0;

  console.info(
    `[Auto-Ingest] Done: ${summaryId} — ${chunks.length} chunks, ` +
      `${generated} embedded, ${failed} failed, ${elapsed}ms`,
  );

  return {
    summary_id: summaryId,
    chunks_created: chunks.length,
    embeddings_generated: generated,
    embeddings_failed: failed,
    strategy_used: chunks[0]?.strategy ?? "recursive",
    elapsed_ms: elapsed,
  };
}
