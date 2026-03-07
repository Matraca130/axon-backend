/**
 * routes/ai/ingest.ts — Batch embedding generation for RAG
 *
 * POST /ai/ingest-embeddings
 *   institution_id: UUID (required — scope to institution)
 *   target: "chunks" | "summaries" (default: "chunks")
 *   summary_id: UUID (optional, further scope to one summary — chunks only)
 *   batch_size: number (default 50, max 100)
 *
 * Targets:
 *   "chunks"    — Generate embeddings for chunks without embeddings (original)
 *   "summaries" — Generate summary-level embeddings for coarse-to-fine search (Fase 3)
 *
 * Pre-flight fixes applied:
 *   PF-02 FIX: Added institution scoping + requireInstitutionRole(CONTENT_WRITE_ROLES)
 *   PF-05 FIX: DB query happens before API call (JWT validation)
 *   PF-09 FIX: Uses getAdminClient() for embedding UPDATE to bypass RLS
 *
 * Live-audit fixes applied:
 *   LA-01 FIX: Fallback query now scopes by institution via get_institution_summary_ids
 *
 * Coherence fixes applied:
 *   INC-5 FIX: Changed fallback RPC from get_course_summary_ids (wrong param name)
 *              to get_institution_summary_ids (correct, takes p_institution_id)
 *
 * Fase 3 additions:
 *   3.4: target="summaries" mode — batch summary embedding via embedSummaryContent()
 *   A2:  Added `skipped` counter for empty-content summaries (audit fix)
 *
 * D57-D62: Embedding migration — generateEmbedding now from openai-embeddings.ts
 *          (OpenAI text-embedding-3-large 1536d). taskType parameter removed.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, getAdminClient, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import { generateEmbedding } from "../../openai-embeddings.ts";
import { embedSummaryContent } from "../../auto-ingest.ts";

export const aiIngestRoutes = new Hono();

// ─── Valid target values ────────────────────────────────────────────
const VALID_TARGETS = ["chunks", "summaries"] as const;
type IngestTarget = typeof VALID_TARGETS[number];

aiIngestRoutes.post(`${PREFIX}/ai/ingest-embeddings`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  // ── PF-02 FIX: Require institution_id and verify role ───────
  const institutionId = body.institution_id as string;
  if (!isUuid(institutionId))
    return err(c, "institution_id is required (UUID)", 400);

  // ⚠️ PF-05: This DB query validates the JWT cryptographically via PostgREST.
  // It MUST happen before any embedding API call.
  const roleCheck = await requireInstitutionRole(
    db, user.id, institutionId, CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck))
    return err(c, roleCheck.message, roleCheck.status);

  // ── Parse target (Fase 3) ───────────────────────────────────
  const target: IngestTarget =
    typeof body.target === "string" && VALID_TARGETS.includes(body.target as IngestTarget)
      ? (body.target as IngestTarget)
      : "chunks";

  const summaryId = body.summary_id;
  let batchSize = parseInt(String(body.batch_size ?? "50"), 10);
  if (isNaN(batchSize) || batchSize < 1) batchSize = 50;
  if (batchSize > 100) batchSize = 100;

  const adminDb = getAdminClient();

  // ════════════════════════════════════════════════════════════════
  // TARGET: "summaries" — Fase 3 batch summary embedding
  // ════════════════════════════════════════════════════════════════
  if (target === "summaries") {
    return await ingestSummaryEmbeddings(c, adminDb, institutionId, batchSize);
  }

  // ════════════════════════════════════════════════════════════════
  // TARGET: "chunks" — Original chunk embedding logic
  // ════════════════════════════════════════════════════════════════

  // ── Fetch chunks without embeddings, scoped to institution ───
  // Build query: chunks → summaries → topics → sections → semesters → courses
  // Filter: institution_id match + no embedding yet
  let query = adminDb
    .from("chunks")
    .select(`
      id, content, summary_id,
      summaries!inner (
        topics!inner (
          sections!inner (
            semesters!inner (
              courses!inner ( institution_id )
            )
          )
        )
      )
    `)
    .is("embedding", null)
    .eq("summaries.topics.sections.semesters.courses.institution_id", institutionId)
    .limit(batchSize);

  if (summaryId && isUuid(summaryId)) {
    query = query.eq("summary_id", summaryId);
  }

  const { data: chunks, error: fetchErr } = await query;

  // ── LA-01 + INC-5 FIX: Scoped fallback using get_institution_summary_ids ──
  // The nested !inner join can fail with deeply chained PostgREST relations.
  // CRITICAL: The fallback MUST maintain institution scoping to prevent
  // cross-tenant data leakage. We resolve valid summary_ids first, then
  // filter chunks by those IDs.
  //
  // INC-5 FIX: Previously called get_course_summary_ids with p_institution_id
  // parameter, but that function expects p_course_id. The parameter name
  // mismatch caused PostgreSQL to reject the call. Now uses the correct
  // get_institution_summary_ids(p_institution_id) RPC.
  let chunksToProcess = chunks;
  if (fetchErr || !chunks) {
    console.warn(`[Ingest] Nested join failed: ${fetchErr?.message}. Using scoped fallback.`);

    // Step 1: Get summary_ids belonging to this institution
    // INC-5 FIX: Use get_institution_summary_ids (correct RPC)
    const { data: summaryRows, error: rpcErr } = await adminDb.rpc(
      "get_institution_summary_ids",
      { p_institution_id: institutionId },
    );

    if (rpcErr || !summaryRows || summaryRows.length === 0) {
      return ok(c, {
        processed: 0,
        target: "chunks",
        message: rpcErr
          ? `Failed to resolve institution summaries: ${rpcErr.message}`
          : "No summaries found for this institution",
      });
    }

    const validSummaryIds = summaryRows.map(
      (r: { summary_id: string }) => r.summary_id,
    );

    // Step 2: Fetch chunks scoped to those summary_ids
    let fallbackQuery = adminDb
      .from("chunks")
      .select("id, content, summary_id")
      .is("embedding", null)
      .in("summary_id", validSummaryIds)
      .limit(batchSize);

    if (summaryId && isUuid(summaryId)) {
      // Extra guard: verify the requested summary belongs to the institution
      if (!validSummaryIds.includes(summaryId)) {
        return err(c, "summary_id does not belong to this institution", 403);
      }
      fallbackQuery = fallbackQuery.eq("summary_id", summaryId);
    }

    const { data: fallbackChunks, error: fallbackErr } = await fallbackQuery;
    if (fallbackErr)
      return err(c, `Fetch chunks failed: ${fallbackErr.message}`, 500);
    chunksToProcess = fallbackChunks;
  }

  if (!chunksToProcess || chunksToProcess.length === 0)
    return ok(c, { processed: 0, target: "chunks", message: "No chunks without embeddings found" });

  // ── Process each chunk ───────────────────────────────────
  let processed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const chunk of chunksToProcess) {
    try {
      // D57: OpenAI embeddings — no taskType parameter needed
      const embedding = await generateEmbedding(chunk.content);

      // PF-09 FIX: Use adminDb to bypass RLS for embedding updates
      const { error: updateErr } = await adminDb
        .from("chunks")
        .update({ embedding: JSON.stringify(embedding) })
        .eq("id", chunk.id);

      if (updateErr) {
        failed++;
        errors.push(`${chunk.id}: ${updateErr.message}`);
      } else {
        processed++;
      }

      // Respect rate limits: pause 1s every 10 embeddings
      if (processed > 0 && processed % 10 === 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      failed++;
      errors.push(`${chunk.id}: ${(e as Error).message}`);
    }
  }

  return ok(c, {
    processed,
    failed,
    total_found: chunksToProcess.length,
    target: "chunks",
    errors: errors.slice(0, 5), // Only return first 5 errors
  });
});

// ═══════════════════════════════════════════════════════════════════
// Helper: Batch summary embedding
//
// Fetches summaries without embeddings for the given institution,
// and generates + stores a summary-level embedding for each.
//
// Uses embedSummaryContent() from auto-ingest.ts (same function
// used by the auto-ingest pipeline). This ensures consistent
// embedding generation (title + content, truncated at 8000 chars).
//
// A2 FIX: Added `skipped` counter. The SQL filter
// `.not("content_markdown", "is", null)` excludes NULL but not
// empty strings ("") or whitespace-only ("   "). The loop
// correctly skips these, but previously they were invisible
// in the response (processed + failed < total_found with no
// explanation). Now `skipped` makes the accounting transparent:
//   processed + failed + skipped === total_found
//
// Fase 3, sub-task 3.4 — Bloque 2
// ═══════════════════════════════════════════════════════════════════

async function ingestSummaryEmbeddings(
  c: Context,
  adminDb: ReturnType<typeof getAdminClient>,
  institutionId: string,
  batchSize: number,
) {
  // ── Fetch summaries needing embedding ──────────────────────
  //
  // Simple query: summaries.institution_id is denormalized,
  // so no nested JOINs needed (unlike the chunk query).
  //
  // Filters:
  //   - embedding IS NULL: skip already-embedded summaries
  //   - content_markdown IS NOT NULL: nothing to embed without content
  //   - deleted_at IS NULL: don't embed soft-deleted summaries
  //   - is_active = TRUE: don't embed inactive summaries
  //
  // Note: IS NOT NULL does NOT exclude empty strings ("") or
  // whitespace-only strings. Those are caught by the loop guard.

  const { data: summaries, error: fetchErr } = await adminDb
    .from("summaries")
    .select("id, title, content_markdown")
    .eq("institution_id", institutionId)
    .is("embedding", null)
    .not("content_markdown", "is", null)
    .is("deleted_at", null)
    .eq("is_active", true)
    .limit(batchSize);

  if (fetchErr) {
    return err(c, `Failed to fetch summaries: ${fetchErr.message}`, 500);
  }

  if (!summaries || summaries.length === 0) {
    return ok(c, {
      processed: 0,
      failed: 0,
      skipped: 0,
      total_found: 0,
      target: "summaries",
      message: "No summaries without embeddings found for this institution",
    });
  }

  // ── Process each summary ──────────────────────────────────
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const summary of summaries) {
    try {
      const title = (summary.title as string) ?? "";
      const content = summary.content_markdown as string;

      // A2 FIX: Skip empty/whitespace content and count it explicitly.
      // SQL IS NOT NULL doesn't catch "" or "   \n  ".
      if (!content || content.trim().length === 0) {
        skipped++;
        continue;
      }

      await embedSummaryContent(summary.id as string, title, content);
      processed++;

      // Rate limit: pause 1s every 10 embeddings
      // Consistent with chunk embedding pattern
      if (processed > 0 && processed % 10 === 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      failed++;
      errors.push(`${summary.id}: ${(e as Error).message}`);
    }
  }

  return ok(c, {
    processed,
    failed,
    skipped,
    total_found: summaries.length,
    target: "summaries",
    errors: errors.slice(0, 5),
  });
}
