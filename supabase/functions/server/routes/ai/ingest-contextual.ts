/**
 * routes/ai/ingest-contextual.ts — On-demand contextual retrieval backfill
 *
 * POST /ai/ingest-contextual
 *   Body: {
 *     institution_id: UUID          (required, for auth scope)
 *     summary_id?:    UUID          (optional, narrow to a single summary)
 *     limit?:         int           (default 50, max 200)
 *   }
 *   Auth: CONTENT_WRITE_ROLES (owner, admin, professor)
 *
 * Processes chunks that have NULL contextual_content but already have an
 * embedding (i.e. previously ingested under the flag-off path). For each
 * pending chunk we:
 *   1. Fetch the parent summary source text (blocks-flattened or markdown).
 *   2. Ask Haiku 4.5 to produce a contextual prefix.
 *   3. Embed the contextualized text.
 *   4. UPDATE chunks SET contextual_content, contextual_embedding, contextual_model.
 *
 * We never touch the raw `embedding` column — so this route is safe to run
 * against production: if contextualization fails the chunk remains searchable
 * via the existing embedding.
 *
 * Advisory lock key: `ingest-contextual:${summary_id}` (distinct from
 * auto-ingest's `auto-ingest:${summary_id}`), so the two can run in parallel
 * for different summaries without stepping on each other within the same
 * summary.
 *
 * Rate-limited by aiRateLimitMiddleware (100/hr/user). For cross-institution
 * mass backfill use scripts/backfill-contextual.ts with service_role.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import {
  authenticate,
  err,
  getAdminClient,
  ok,
  PREFIX,
  safeJson,
} from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  CONTENT_WRITE_ROLES,
  isDenied,
  requireInstitutionRole,
} from "../../auth-helpers.ts";
import { flattenBlocksToMarkdown } from "../../block-flatten.ts";
import {
  advisoryLockKey,
  tryAcquireAdvisoryLock,
  releaseAdvisoryLock,
} from "../../lib/advisory-lock.ts";
import {
  contextualizeChunks,
  CONTEXTUALIZER_FALLBACK_MODEL,
} from "../../contextualizer.ts";
import { generateEmbeddings } from "../../openai-embeddings.ts";

export const aiIngestContextualRoutes = new Hono();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Resolve the source-of-truth markdown for a summary.
 *
 * Mirrors the logic in auto-ingest.ts Step 2: prefer active summary_blocks
 * (flattened) and fall back to summaries.content_markdown. Returns the
 * full text used for contextualization: `${title}\n\n${body}`.
 */
async function resolveSummaryFullText(
  adminDb: ReturnType<typeof getAdminClient>,
  summaryId: string,
): Promise<{ title: string; fullText: string } | null> {
  const { data: summary, error: sErr } = await adminDb
    .from("summaries")
    .select("title, content_markdown")
    .eq("id", summaryId)
    .single();

  if (sErr || !summary) return null;

  const title = ((summary.title as string) ?? "").trim();
  const contentMarkdown = ((summary.content_markdown as string | null) ?? "").trim();

  let sourceText = "";

  const { data: blockRows } = await adminDb
    .from("summary_blocks")
    .select("id, type, content, order_index")
    .eq("summary_id", summaryId)
    .eq("is_active", true)
    .order("order_index", { ascending: true });

  if (blockRows && blockRows.length > 0) {
    // deno-lint-ignore no-explicit-any
    const flattened = flattenBlocksToMarkdown(blockRows as any);
    if (flattened.trim().length > 0) {
      sourceText = flattened;
    }
  }

  if (sourceText.length === 0 && contentMarkdown.length > 0) {
    sourceText = contentMarkdown;
  }

  if (sourceText.length === 0) return null;

  const fullText = title.length > 0 ? `${title}\n\n${sourceText}` : sourceText;
  return { title, fullText };
}

interface PendingChunk {
  chunk_id: string;
  summary_id: string;
  content: string;
  order_index: number;
  summary_title: string;
}

interface ProcessStats {
  processed: number;
  succeeded: number;
  failed: number;
  fallback_count: number;
  summaries_touched: number;
}

/**
 * Process a group of chunks that all belong to the same summary.
 * Returns per-group stats. Never throws — per-chunk failures are counted.
 */
async function processSummaryGroup(
  adminDb: ReturnType<typeof getAdminClient>,
  summaryId: string,
  chunks: PendingChunk[],
  stats: ProcessStats,
): Promise<void> {
  const resolved = await resolveSummaryFullText(adminDb, summaryId);
  if (!resolved) {
    // Summary has no readable source — mark all pending chunks as failed
    // rather than leaving them stuck forever. The partial index will still
    // pick them up on the next run if the summary later gets content.
    stats.failed += chunks.length;
    console.warn(
      `[ingest-contextual] No source text for summary ${summaryId} — skipping ${chunks.length} chunks`,
    );
    return;
  }

  const { title, fullText } = resolved;

  // 1. Contextualize (parallel, bounded)
  const contextualResults = await contextualizeChunks(
    fullText,
    title,
    chunks.map((c) => c.content),
    3,
  );

  // 2. Embed contextualized texts (batch)
  let contextualEmbeddings: number[][] | null = null;
  try {
    contextualEmbeddings = await generateEmbeddings(
      contextualResults.map((r) => r.contextualContent),
    );
  } catch (e) {
    console.warn(
      `[ingest-contextual] Embedding batch failed for summary ${summaryId}: ${(e as Error).message}`,
    );
    // With no embeddings we can still persist contextual_content + model so the
    // work isn't lost, but the partial index condition (contextual_content IS NULL)
    // won't retry them. We'd rather fail loudly than silently degrade quality,
    // so treat the whole group as failed.
    stats.failed += chunks.length;
    return;
  }

  // 3. UPDATE per chunk. Doing N updates instead of one batched statement
  // because supabase-js doesn't expose an efficient multi-row update here,
  // and N is small (<= 200 per request).
  for (let i = 0; i < chunks.length; i++) {
    const ctx = contextualResults[i];
    const emb = contextualEmbeddings[i];
    stats.processed++;
    if (ctx.fellBack) stats.fallback_count++;

    const { error } = await adminDb
      .from("chunks")
      .update({
        contextual_content: ctx.contextualContent,
        contextual_embedding: JSON.stringify(emb),
        contextual_model: ctx.model,
      })
      .eq("id", chunks[i].chunk_id);

    if (error) {
      stats.failed++;
      console.warn(
        `[ingest-contextual] UPDATE failed for chunk ${chunks[i].chunk_id}: ${error.message}`,
      );
    } else {
      stats.succeeded++;
    }
  }

  stats.summaries_touched++;
}

// ─── Route ────────────────────────────────────────────────────────

aiIngestContextualRoutes.post(
  `${PREFIX}/ai/ingest-contextual`,
  async (c: Context) => {
    const t0 = Date.now();

    // ── 1. Auth ────────────────────────────────────────────────
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    // ── 2. Body ────────────────────────────────────────────────
    const body = await safeJson(c);
    if (!body) return err(c, "Invalid JSON body", 400);

    const institutionId = body.institution_id as string;
    if (!isUuid(institutionId)) {
      return err(c, "institution_id is required (UUID)", 400);
    }

    const summaryId = body.summary_id as string | undefined;
    if (summaryId !== undefined && !isUuid(summaryId)) {
      return err(c, "summary_id must be a UUID if provided", 400);
    }

    let limit = DEFAULT_LIMIT;
    if (body.limit !== undefined) {
      const parsed = Number(body.limit);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return err(c, "limit must be a positive number", 400);
      }
      limit = Math.min(Math.floor(parsed), MAX_LIMIT);
    }

    // ── 3. Role check ──────────────────────────────────────────
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      institutionId,
      CONTENT_WRITE_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }

    const adminDb = getAdminClient();

    // ── 4. Cross-institution guard (when summaryId provided) ───
    if (summaryId) {
      const { data: sRow, error: sErr } = await adminDb
        .from("summaries")
        .select("institution_id")
        .eq("id", summaryId)
        .single();
      if (sErr || !sRow) return err(c, "Summary not found", 404);
      if (sRow.institution_id !== institutionId) {
        return err(c, "Summary does not belong to this institution", 403);
      }
    }

    // ── 5. Advisory lock ───────────────────────────────────────
    // When summaryId is given we lock per-summary so two concurrent callers
    // don't double-contextualize the same chunks. For institution-wide runs
    // we use an institution-level lock to serialize large jobs.
    const lockLabel = summaryId
      ? `ingest-contextual:${summaryId}`
      : `ingest-contextual:inst:${institutionId}`;
    const lockKey = advisoryLockKey(lockLabel);

    const acquired = await tryAcquireAdvisoryLock(adminDb, lockKey);
    if (!acquired) {
      return err(c, `Another contextualization is already running for ${lockLabel}`, 409);
    }

    try {
      // ── 6. Fetch pending chunks ──────────────────────────────
      const { data: pending, error: rpcErr } = await adminDb.rpc(
        "get_chunks_for_contextual",
        {
          p_summary_id: summaryId ?? null,
          p_institution_id: summaryId ? null : institutionId,
          p_limit: limit,
        },
      );

      if (rpcErr) {
        return err(c, `get_chunks_for_contextual failed: ${rpcErr.message}`, 500);
      }

      const pendingChunks = (pending ?? []) as PendingChunk[];

      if (pendingChunks.length === 0) {
        return ok(c, {
          processed: 0,
          succeeded: 0,
          failed: 0,
          fallback_count: 0,
          summaries_touched: 0,
          fallback_model: CONTEXTUALIZER_FALLBACK_MODEL,
          elapsed_ms: Date.now() - t0,
          message: "no pending chunks",
        });
      }

      // ── 7. Group by summary_id ───────────────────────────────
      // RPC already ORDERs by summary_id so a simple sequential scan works.
      const groups = new Map<string, PendingChunk[]>();
      for (const chunk of pendingChunks) {
        const bucket = groups.get(chunk.summary_id);
        if (bucket) {
          bucket.push(chunk);
        } else {
          groups.set(chunk.summary_id, [chunk]);
        }
      }

      // ── 8. Process groups sequentially ───────────────────────
      const stats: ProcessStats = {
        processed: 0,
        succeeded: 0,
        failed: 0,
        fallback_count: 0,
        summaries_touched: 0,
      };

      for (const [groupSummaryId, groupChunks] of groups) {
        await processSummaryGroup(adminDb, groupSummaryId, groupChunks, stats);
      }

      // ── 9. Response ──────────────────────────────────────────
      return ok(c, {
        ...stats,
        fallback_model: CONTEXTUALIZER_FALLBACK_MODEL,
        elapsed_ms: Date.now() - t0,
      });
    } finally {
      await releaseAdvisoryLock(adminDb, lockKey, lockLabel);
    }
  },
);
