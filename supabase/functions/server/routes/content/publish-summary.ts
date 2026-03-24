/**
 * publish-summary.ts — POST /server/summaries/:id/publish
 *
 * Publish a block-based summary:
 * 1. Verify status = 'review' and has active blocks
 * 2. Flatten blocks → content_markdown
 * 3. Update status → 'published'
 * 4. Auto-chunk + embed the full markdown (reuses existing pipeline)
 * 5. Generate per-block embeddings in batches of 5
 * 6. Return { status, chunks_count, blocks_embedded }
 *
 * Auth: Requires CONTENT_WRITE_ROLES membership in the summary's institution.
 *
 * Fase 4, TASK_9
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import { flattenBlocksToMarkdown } from "../../block-flatten.ts";
import { autoChunkAndEmbed } from "../../auto-ingest.ts";
import { generateEmbedding } from "../../openai-embeddings.ts";
import type { Context } from "npm:hono";

export const publishSummaryRoutes = new Hono();

publishSummaryRoutes.post(
  `${PREFIX}/summaries/:id/publish`,
  async (c: Context) => {
    // ── 1. Auth ─────────────────────────────────────────────
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const summaryId = c.req.param("id");
    if (!summaryId) return err(c, "Missing summary ID", 400);

    // ── 2. Fetch summary + verify institution access ────────
    const admin = getAdminClient();

    const { data: summary, error: fetchErr } = await admin
      .from("summaries")
      .select("id, status, institution_id, topic_id")
      .eq("id", summaryId)
      .single();

    if (fetchErr || !summary) {
      return err(c, "Summary not found", 404);
    }

    // Check write access
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      summary.institution_id,
      CONTENT_WRITE_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }

    // ── 3. Verify status = 'review' ────────────────────────
    if (summary.status !== "review") {
      return err(
        c,
        `Cannot publish: summary status is '${summary.status}', expected 'review'`,
        409,
      );
    }

    // ── 4. Fetch active blocks ──────────────────────────────
    const { data: blocks, error: blocksErr } = await admin
      .from("summary_blocks")
      .select("id, type, content, order_index")
      .eq("summary_id", summaryId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("order_index", { ascending: true });

    if (blocksErr) return safeErr(c, "Fetch blocks", blocksErr);

    if (!blocks || blocks.length === 0) {
      return err(c, "Cannot publish: summary has no active blocks", 409);
    }

    // ── 5. Flatten blocks → markdown ────────────────────────
    const contentMarkdown = flattenBlocksToMarkdown(blocks);

    if (!contentMarkdown || contentMarkdown.trim().length === 0) {
      return err(c, "Cannot publish: flattened content is empty", 409);
    }

    // ── 6. Update summary: content_markdown + status → 'published' ──
    const { error: updateErr } = await admin
      .from("summaries")
      .update({
        content_markdown: contentMarkdown,
        status: "published",
        updated_at: new Date().toISOString(),
      })
      .eq("id", summaryId);

    if (updateErr) return safeErr(c, "Update summary", updateErr);

    // ── 7. Auto-chunk + embed full markdown (fire-and-forget-ish) ───
    let chunksCount = 0;
    try {
      const ingestResult = await autoChunkAndEmbed(
        summaryId,
        summary.institution_id,
      );
      chunksCount = ingestResult.chunks_created;
    } catch (e) {
      console.error(
        `[Publish] Auto-ingest failed for summary ${summaryId}:`,
        (e as Error).message,
      );
    }

    // ── 8. Per-block embeddings in batches of 5 ─────────────
    let blocksEmbedded = 0;
    let blocksFailed = 0;
    const BATCH_SIZE = 5;

    for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
      const batch = blocks.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (block) => {
          const text = flattenBlocksToMarkdown([block]);
          if (!text || text.trim().length === 0) return null;

          const embedding = await generateEmbedding(text);

          const { error: embedErr } = await admin
            .from("summary_block_embeddings")
            .upsert(
              {
                block_id: block.id,
                summary_id: summaryId,
                embedding,
                content_text: text.slice(0, 2000), // Truncate for storage
                updated_at: new Date().toISOString(),
              },
              { onConflict: "block_id" },
            );

          if (embedErr) {
            console.warn(
              `[Publish] Block embedding failed for ${block.id}:`,
              embedErr.message,
            );
            return null;
          }

          return block.id;
        }),
      );

      for (const r of results) {
        if (r.status === "fulfilled" && r.value !== null) {
          blocksEmbedded++;
        } else if (r.status === "rejected") {
          blocksFailed++;
        }
      }
    }

    // ── 9. Return result ────────────────────────────────────
    return ok(c, {
      status: "published",
      chunks_count: chunksCount,
      blocks_embedded: blocksEmbedded,
      blocks_failed: blocksFailed,
      total_blocks: blocks.length,
    });
  },
);
