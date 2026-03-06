/**
 * summary-hook.ts — afterWrite hook for summaries
 *
 * Called by crud-factory.ts fire-and-forget after successful
 * POST or PUT on the summaries table.
 *
 * Triggers autoChunkAndEmbed() to split the summary's
 * content_markdown into chunks and generate embeddings.
 *
 * Trigger conditions:
 *   - POST (create): always, if content_markdown is non-empty
 *   - PUT (update): only if content_markdown was in the update payload
 *
 * Non-trigger scenarios (no-op):
 *   - POST with only title (no content_markdown)
 *   - PUT changing status, order_index, title, etc.
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
}: AfterWriteParams): void {
  // ── Gate 1: On update, only trigger if content_markdown changed.
  //
  // Cheapest check first (array lookup, ~nanoseconds).
  // Prevents unnecessary re-chunking when the professor only
  // changed title, status, order_index, or estimated_study_minutes.
  if (action === "update" && !updatedFields?.includes("content_markdown")) {
    return;
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

  // ── Gate 3: Skip if no content to chunk.
  //
  // autoChunkAndEmbed has its own empty-content guard, but
  // checking here avoids a wasted DB call (fetch summary).
  const contentMarkdown = row.content_markdown as string | null;

  if (!contentMarkdown || contentMarkdown.trim().length === 0) {
    return;
  }

  // ── Fire: trigger auto-ingest (fire-and-forget).
  //
  // - NOT awaited: the HTTP response returns immediately.
  // - autoChunkAndEmbed logs its own start/end messages,
  //   so .then() is intentionally silent to avoid double-logging.
  // - .catch() logs errors that escape autoChunkAndEmbed
  //   (fatal throws: summary not found, chunk INSERT failed).
  autoChunkAndEmbed(summaryId, institutionId).catch((e) => {
    console.error(
      `[Summary Hook] Auto-ingest failed for summary ${summaryId}:`,
      (e as Error).message,
    );
  });
}
