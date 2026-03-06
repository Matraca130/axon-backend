/**
 * auto-ingest.ts — Automatic chunk + embed pipeline for Axon RAG
 *
 * Pure business-logic function, zero Hono/HTTP dependency.
 * Called by:
 *   - POST /ai/re-chunk  (5.6 — synchronous, professor waits)
 *   - POST/PATCH summary hooks (5.8 — fire-and-forget)
 *
 * Flow:
 *   1. Fetch summary content from DB
 *   2. Split into chunks via chunker.ts
 *   3. Replace existing chunks (DELETE → INSERT)
 *   4. Generate embeddings for each chunk (sequential, rate-limited)
 *   5. Update summaries.last_chunked_at
 *   6. Generate summary-level embedding (Fase 3)
 *
 * Also exports:
 *   - truncateAtWord()       — text utility for safe truncation at word boundary
 *   - embedSummaryContent()  — standalone summary embedding (for batch ingest)
 *
 * Error strategy:
 *   - Throws on fatal errors (summary not found, INSERT failed)
 *   - Absorbs embedding failures → returns embeddings_failed count
 *   - Summary embedding failure is non-fatal in pipeline context
 *   - Caller decides whether to throw or log
 *
 * Fase 5, sub-task 5.5 — Issue #30
 * Fase 3, sub-tasks 3.2/3.3 — Summary embeddings (Bloque 2)
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
  /** Whether the summary-level embedding was generated successfully (Fase 3) */
  summary_embedded: boolean;
  /** Total wall-clock time in milliseconds */
  elapsed_ms: number;
}

// ─── Text Utilities ─────────────────────────────────────────────────

/**
 * Truncate text at a word boundary, never exceeding maxChars.
 *
 * Used to prepare summary content for embedding generation.
 * Gemini embedding-001 supports ~10K tokens; we truncate at 8000
 * chars to leave ~2K tokens of margin.
 *
 * @param text      The text to truncate
 * @param maxChars  Maximum character count
 * @returns         Truncated text (may be shorter than maxChars)
 *
 * @example
 *   truncateAtWord("Hello world foo", 11)
 *   // → "Hello world"  (cuts at space before position 11)
 *
 *   truncateAtWord("Short", 100)
 *   // → "Short"  (no truncation needed)
 */
export function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Find the last space at or before maxChars
  const cutPoint = text.lastIndexOf(" ", maxChars);

  // Edge case: no spaces in the text (e.g., a single very long word
  // or CJK text without spaces) → hard cut
  if (cutPoint <= 0) return text.slice(0, maxChars);

  return text.slice(0, cutPoint);
}

// ─── Summary Embedding ──────────────────────────────────────────────

/** Max chars for summary embedding input. 8000 chars ≈ 2000-2500 tokens,
 *  well within Gemini embedding-001's ~10K token limit. */
const SUMMARY_EMBED_MAX_CHARS = 8000;

/**
 * Generate and store an embedding for a summary's full content.
 *
 * Concatenates title + content_markdown, truncates to safe length,
 * generates a 768d embedding, and stores it in summaries.embedding.
 *
 * This function THROWS on failure. The caller decides whether to
 * absorb or propagate the error:
 *   - autoChunkAndEmbed(): catches + warns (non-fatal in pipeline)
 *   - ingest.ts batch:    catches + increments failed counter
 *   - Direct call:        propagates to HTTP handler
 *
 * @param summaryId         UUID of the summary
 * @param title             Summary title (may be empty string)
 * @param contentMarkdown   Summary content (must be non-empty)
 * @throws                  If embedding generation or DB update fails
 *
 * Fase 3, sub-task 3.2 — Bloque 2
 */
export async function embedSummaryContent(
  summaryId: string,
  title: string,
  contentMarkdown: string,
): Promise<void> {
  // Concatenate title + content with semantic separator.
  // The ". " signals to the embedding model that the title
  // is a distinct semantic unit from the body.
  const combined = title.trim().length > 0
    ? `${title.trim()}. ${contentMarkdown}`
    : contentMarkdown;

  const truncated = truncateAtWord(combined, SUMMARY_EMBED_MAX_CHARS);

  const embedding = await generateEmbedding(truncated, "RETRIEVAL_DOCUMENT");

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
      summary_embedded: false,
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
      summary_embedded: false,
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

  // ── Step 7: Generate chunk embeddings (sequential, rate-limited)
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

  // ── Step 8: Generate summary-level embedding (Fase 3) ─────────
  //
  // Embed the FULL summary (title + content_markdown) as a single
  // vector. This enables coarse-to-fine search: the summary embedding
  // provides macro-relevance signal, then chunk embeddings provide
  // fine-grained matches.
  //
  // Non-fatal: if this fails, chunk embeddings are still intact.
  // The summary embedding can be generated later via:
  //   POST /ai/ingest-embeddings { target: "summaries" }
  //
  // This is the LAST async step, placed AFTER chunk embeddings
  // because chunks are more critical for search quality.

  let summaryEmbedded = false;

  try {
    await embedSummaryContent(summaryId, title, contentMarkdown);
    summaryEmbedded = true;
  } catch (e) {
    // Non-fatal: chunk embeddings already succeeded.
    // Log at warn level — this is a degradation, not a failure.
    console.warn(
      `[Auto-Ingest] Summary embedding failed for ${summaryId}: ` +
        (e as Error).message,
    );
  }

  // ── Step 9: Return result ─────────────────────────────────────

  const elapsed = Date.now() - t0;

  console.info(
    `[Auto-Ingest] Done: ${summaryId} — ${chunks.length} chunks, ` +
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
}
