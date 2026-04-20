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
import { autoChunkAndEmbed, type PreloadedBlock } from "../../auto-ingest.ts";
import { generateEmbedding, generateEmbeddings } from "../../openai-embeddings.ts";
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

    // ── 7. Run auto-ingest + per-block embeddings IN PARALLEL ──
    //
    // Both paths share the same blocks already in memory. Auto-ingest
    // gets them via `preloadedBlocks` (skips its own SELECT). Per-block
    // embeddings batch all texts in a single OpenAI call (vs the prior
    // 5-at-a-time loop with per-block HTTP round-trips).
    //
    // Concurrency note (audit H4): both paths call OpenAI within the
    // same publish window. `generateEmbeddings` already throttles
    // internally (BATCH_SIZE=100 + 3-retry backoff in openai-embeddings.ts),
    // so doubling the concurrency here is safe in practice. If TPM
    // pressure is observed in logs (rate-limit headers), serialize by
    // awaiting ingestPromise before blockEmbedPromise.
    const blockTexts = blocks.map((b) => {
      const t = flattenBlocksToMarkdown([b]);
      return (t && t.trim().length > 0) ? t : null;
    });

    const ingestPromise = autoChunkAndEmbed(
      summaryId,
      summary.institution_id,
      undefined, // options
      undefined, // strategy
      blocks as PreloadedBlock[],
    ).catch((e: unknown) => {
      console.error(
        `[Publish] Auto-ingest failed for summary ${summaryId}:`,
        (e as Error).message,
      );
      return null;
    });

    const blockEmbedPromise = (async () => {
      const validIndices: number[] = [];
      const validTexts: string[] = [];
      for (let i = 0; i < blockTexts.length; i++) {
        const t = blockTexts[i];
        if (t !== null) {
          validIndices.push(i);
          validTexts.push(t);
        }
      }
      if (validTexts.length === 0) {
        return { embedded: 0, failed: 0 };
      }

      let embeddings: number[][] = [];
      try {
        embeddings = await generateEmbeddings(validTexts);
      } catch (e) {
        // Fallback to per-block sequential (preserves prior behavior on
        // batch failure — important for partial OpenAI outages).
        console.warn(
          `[Publish] Batch block embedding failed, falling back to sequential: ${(e as Error).message}`,
        );
        embeddings = [];
        for (const text of validTexts) {
          try {
            embeddings.push(await generateEmbedding(text));
          } catch (innerErr) {
            console.warn(
              `[Publish] Sequential embedding failed: ${(innerErr as Error).message}`,
            );
            embeddings.push([]); // sentinel — will be filtered
          }
        }
      }

      // Bulk upsert all valid embeddings in a single round-trip.
      const upsertRows = validIndices
        .map((blockIdx, embIdx) => {
          const emb = embeddings[embIdx];
          if (!emb || emb.length === 0) return null;
          return {
            block_id: blocks[blockIdx].id,
            summary_id: summaryId,
            embedding: emb,
            content_text: validTexts[embIdx].slice(0, 2000),
            updated_at: new Date().toISOString(),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (upsertRows.length === 0) {
        return { embedded: 0, failed: validTexts.length };
      }

      const { error: upsertErr } = await admin
        .from("summary_block_embeddings")
        .upsert(upsertRows, { onConflict: "block_id" });

      if (upsertErr) {
        console.warn(
          `[Publish] Bulk block-embeddings upsert failed: ${upsertErr.message}`,
        );
        return { embedded: 0, failed: validTexts.length };
      }

      return {
        embedded: upsertRows.length,
        failed: validTexts.length - upsertRows.length,
      };
    })();

    const [ingestResult, blockEmbedResult] = await Promise.all([
      ingestPromise,
      blockEmbedPromise,
    ]);

    const chunksCount = ingestResult?.chunks_created ?? 0;
    const blocksEmbedded = blockEmbedResult.embedded;
    const blocksFailed = blockEmbedResult.failed;

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
