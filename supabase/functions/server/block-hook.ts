/**
 * block-hook.ts — afterWrite hook for summary_blocks
 *
 * Called by crud-factory.ts fire-and-forget after successful
 * POST or PUT on the summary_blocks table.
 *
 * Two responsibilities:
 *
 * 1. Dirty-flag the parent summary: when a block is edited on a
 *    published summary, revert status 'published' → 'review' so
 *    stale embeddings aren't served to students.
 *
 * 2. Re-chunk + re-embed: run autoChunkAndEmbed on the parent
 *    summary so the chunks table stays in sync with the latest
 *    block content. Without this, block-based summaries only get
 *    chunks at publish time and go stale between edits, forcing
 *    the RAG chat into the block-fallback path instead of real
 *    semantic search.
 *
 * Behavior:
 *   - Missing summary_id → log warning, return
 *   - Missing institution_id on parent → log warning, skip re-chunk
 *   - status = 'published' → revert to 'review' + re-chunk
 *   - other statuses → re-chunk only
 *   - All errors absorbed (fire-and-forget, never affects CRUD response)
 *
 * Fase 4, TASK_7 (+ autoChunk follow-up)
 */

import type { AfterWriteParams } from "./crud-factory.ts";
import { getAdminClient } from "./db.ts";
import { autoChunkAndEmbed } from "./auto-ingest.ts";

/**
 * afterWrite hook for summary_blocks.
 *
 * Fire-and-forget: the CRUD response is NEVER delayed by this hook.
 * All async work is managed internally with .catch().
 */
export function onBlockWrite({
  row,
}: AfterWriteParams): void {
  const summaryId = row.summary_id as string | undefined;

  if (!summaryId) {
    console.warn(
      `[Block Hook] Missing summary_id in row. ` +
        `Skipping dirty-flag check. Row keys: ${Object.keys(row).join(", ")}`,
    );
    return;
  }

  // Fire-and-forget: revert published→review AND trigger re-chunk.
  handleBlockWrite(summaryId).catch((e) => {
    console.error(
      `[Block Hook] Failed to process summary ${summaryId}:`,
      (e as Error).message,
    );
  });
}

/**
 * Fetch parent summary, revert status if published, and trigger
 * autoChunkAndEmbed. Uses the admin client to bypass RLS.
 */
async function handleBlockWrite(summaryId: string): Promise<void> {
  const admin = getAdminClient();

  // 1. Fetch current status + institution_id (needed for auto-ingest)
  const { data: summary, error: fetchErr } = await admin
    .from("summaries")
    .select("id, status, institution_id")
    .eq("id", summaryId)
    .single();

  if (fetchErr || !summary) {
    console.warn(
      `[Block Hook] Could not fetch summary ${summaryId}: ${fetchErr?.message ?? "not found"}`,
    );
    return;
  }

  // 2. Revert status if currently published
  if (summary.status === "published") {
    const { error: updateErr } = await admin
      .from("summaries")
      .update({ status: "review", updated_at: new Date().toISOString() })
      .eq("id", summaryId);

    if (updateErr) {
      console.error(
        `[Block Hook] Failed to revert summary ${summaryId} to review:`,
        updateErr.message,
      );
      // Continue to re-chunk anyway — the chunks should still be refreshed.
    } else {
      console.info(
        `[Block Hook] Reverted summary ${summaryId} from 'published' → 'review'`,
      );
    }
  }

  // 3. Re-chunk + re-embed so the chunks table matches the new block state.
  //    autoChunkAndEmbed reads summary_blocks directly, holds an advisory
  //    lock per summary, and skips if the content hash hasn't changed —
  //    so rapid block edits are coalesced efficiently.
  const institutionId = summary.institution_id as string | undefined;
  if (!institutionId) {
    console.warn(
      `[Block Hook] Summary ${summaryId} has no institution_id; skipping auto-ingest.`,
    );
    return;
  }

  try {
    await autoChunkAndEmbed(summaryId, institutionId);
  } catch (e) {
    console.error(
      `[Block Hook] Auto-ingest failed for summary ${summaryId}:`,
      (e as Error).message,
    );
  }
}
