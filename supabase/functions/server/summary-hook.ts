/**
 * summary-hook.ts — afterWrite hook for summaries
 *
 * Called by crud-factory.ts fire-and-forget after successful
 * POST or PUT on the summaries table.
 *
 * Triggers autoChunkAndEmbed() which picks the source of truth
 * (summary_blocks if present, otherwise content_markdown) and
 * generates chunks + embeddings.
 *
 * Trigger conditions:
 *   - POST (create): always fire (auto-ingest is cheap no-op
 *     when both blocks and content_markdown are empty)
 *   - PUT (update): only if content_markdown or title was in the
 *     update payload. Block edits fire via block-hook.ts instead.
 *
 * Non-trigger scenarios (no-op):
 *   - PUT changing only status, order_index, is_active, etc.
 *   - DELETE / RESTORE (hook is not wired to these actions)
 *
 * Error handling:
 *   - All errors are absorbed and logged. The CRUD response
 *     is NEVER affected by hook failures.
 *   - autoChunkAndEmbed itself absorbs embedding failures
 *     (returns embeddings_failed count). Only fatal errors
 *     (summary not found, INSERT failed) throw — caught here.
 *
 * Fase 5, sub-task 5.8 — Issue #30
 */

import type { AfterWriteParams } from "./crud-factory.ts";
import { autoChunkAndEmbed } from "./auto-ingest.ts";

// Fields whose change should trigger re-chunking of the summary.
// Title is included because it's prepended to the embedded text,
// so title edits affect both chunk and summary-level embeddings.
const CHUNK_RELEVANT_FIELDS = new Set(["content_markdown", "title"]);

/**
 * afterWrite hook for summaries.
 *
 * Decides whether to trigger auto-ingest based on the action
 * type and which fields were actually modified.
 *
 * @param params - Provided by crud-factory.ts after successful POST/PUT
 */
export function onSummaryWrite({
  action,
  row,
  updatedFields,
  waitUntil,
}: AfterWriteParams): void {
  // ── Gate 1: On update, only trigger if a chunk-relevant field changed.
  //
  // Block edits do NOT flow through this hook — they come via
  // summary_blocks writes handled by block-hook.ts. Avoid re-embedding
  // when the professor just flipped a status/order_index flag.
  if (action === "update") {
    const touched = updatedFields ?? [];
    const chunkRelevant = touched.some((f) => CHUNK_RELEVANT_FIELDS.has(f));
    if (!chunkRelevant) {
      return;
    }
  }

  // ── Gate 2: Extract identifiers from the full row.
  //
  // The row comes from .select() which returns ALL columns.
  // summaries has a denormalized institution_id column —
  // reading it directly avoids an extra RPC call.
  const summaryId = row.id as string | undefined;
  const institutionId = row.institution_id as string | undefined;

  if (!summaryId || !institutionId) {
    console.warn(
      `[Summary Hook] Missing id or institution_id in row. ` +
        `Skipping auto-ingest. Row keys: ${Object.keys(row).join(", ")}`,
    );
    return;
  }

  // ── Fire-and-forget: run auto-ingest.
  //
  // autoChunkAndEmbed handles the source-of-truth resolution:
  //   1. Prefer summary_blocks (Smart Reader / block-based flow)
  //   2. Fall back to content_markdown (legacy / PDF-ingested)
  //   3. No-op if both are empty
  //
  // It also holds an advisory lock per summary, so concurrent
  // block edits collapsing into multiple hook fires won't
  // race with each other.
  //
  // Must be registered with waitUntil (when available) or the runtime
  // cancels the promise as soon as the CRUD handler returns — every
  // organically-created summary in prod had last_chunked_at = NULL
  // because of this bug before the waitUntil param landed in crud-factory.
  const ingestPromise = autoChunkAndEmbed(summaryId, institutionId).catch((e) => {
    console.error(
      `[Summary Hook] Auto-ingest failed for summary ${summaryId}:`,
      (e as Error).message,
    );
  });
  waitUntil?.(ingestPromise);
}
