/**
 * block-hook.ts — afterWrite hook for summary_blocks
 *
 * Called by crud-factory.ts fire-and-forget after successful
 * POST or PUT on the summary_blocks table.
 *
 * Purpose: When a block is edited on a published summary,
 * revert the summary status to 'review' (dirty flag).
 * This ensures published summaries aren't served with stale
 * embeddings — the professor must re-publish to regenerate them.
 *
 * Behavior:
 *   - status = 'published' → revert to 'review'
 *   - status = 'review'/'raw'/'draft' → no-op (already dirty)
 *   - Missing summary_id → log warning, return
 *   - All errors are absorbed and logged (fire-and-forget)
 *
 * Fase 4, TASK_7
 */

import type { AfterWriteParams } from "./crud-factory.ts";
import { getAdminClient } from "./db.ts";

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

  // Fire-and-forget: check summary status and revert if published.
  revertIfPublished(summaryId).catch((e) => {
    console.error(
      `[Block Hook] Failed to check/revert summary ${summaryId}:`,
      (e as Error).message,
    );
  });
}

/**
 * Check the summary's current status. If 'published', revert to 'review'.
 * Uses admin client to bypass RLS (the hook runs in server context).
 */
async function revertIfPublished(summaryId: string): Promise<void> {
  const admin = getAdminClient();

  // 1. Fetch current status
  const { data: summary, error: fetchErr } = await admin
    .from("summaries")
    .select("id, status")
    .eq("id", summaryId)
    .single();

  if (fetchErr || !summary) {
    console.warn(
      `[Block Hook] Could not fetch summary ${summaryId}: ${fetchErr?.message ?? "not found"}`,
    );
    return;
  }

  // 2. Only revert if currently published
  if (summary.status !== "published") {
    return;
  }

  // 3. Revert to 'review'
  const { error: updateErr } = await admin
    .from("summaries")
    .update({ status: "review", updated_at: new Date().toISOString() })
    .eq("id", summaryId);

  if (updateErr) {
    console.error(
      `[Block Hook] Failed to revert summary ${summaryId} to review:`,
      updateErr.message,
    );
    return;
  }

  console.info(
    `[Block Hook] Reverted summary ${summaryId} from 'published' → 'review'`,
  );
}
