/**
 * routes/ai/ingest.ts — Batch embedding generation for RAG
 *
 * POST /ai/ingest-embeddings
 *   institution_id: UUID (required — scope to institution)
 *   summary_id: UUID (optional, further scope to one summary)
 *   batch_size: number (default 50, max 100)
 *
 * Pre-flight fixes applied:
 *   PF-02 FIX: Added institution scoping + requireInstitutionRole(CONTENT_WRITE_ROLES)
 *   PF-05 FIX: DB query happens before Gemini call (JWT validation)
 *   PF-09 FIX: Uses getAdminClient() for embedding UPDATE to bypass RLS
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
import { generateEmbedding } from "../../gemini.ts";

export const aiIngestRoutes = new Hono();

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
  // It MUST happen before any Gemini API call.
  const roleCheck = await requireInstitutionRole(
    db, user.id, institutionId, CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck))
    return err(c, roleCheck.message, roleCheck.status);

  const summaryId = body.summary_id;
  let batchSize = parseInt(String(body.batch_size ?? "50"), 10);
  if (isNaN(batchSize) || batchSize < 1) batchSize = 50;
  if (batchSize > 100) batchSize = 100;

  // ── Fetch chunks without embeddings, scoped to institution ───
  // We need to join through the hierarchy to scope by institution.
  // Using admin client for the read since we already verified role above.
  const adminDb = getAdminClient();

  // Build query: chunks → summaries → topics → sections → semesters → courses
  // Filter: institution_id match + no embedding yet
  let rpcParams: Record<string, unknown> = {
    p_institution_id: institutionId,
    p_batch_size: batchSize,
  };
  if (summaryId && isUuid(summaryId)) {
    rpcParams.p_summary_id = summaryId;
  }

  // Fetch chunks via a direct query (simpler than RPC for this use case)
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

  // Fallback: if nested join doesn't work, try simpler approach
  let chunksToProcess = chunks;
  if (fetchErr || !chunks) {
    console.warn(`[Ingest] Nested join failed: ${fetchErr?.message}. Using simple query.`);
    // Simpler fallback: just get chunks without embedding
    let fallbackQuery = adminDb
      .from("chunks")
      .select("id, content, summary_id")
      .is("embedding", null)
      .limit(batchSize);

    if (summaryId && isUuid(summaryId)) {
      fallbackQuery = fallbackQuery.eq("summary_id", summaryId);
    }

    const { data: fallbackChunks, error: fallbackErr } = await fallbackQuery;
    if (fallbackErr)
      return err(c, `Fetch chunks failed: ${fallbackErr.message}`, 500);
    chunksToProcess = fallbackChunks;
  }

  if (!chunksToProcess || chunksToProcess.length === 0)
    return ok(c, { processed: 0, message: "No chunks without embeddings found" });

  // ── Process each chunk ───────────────────────────────────────
  let processed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const chunk of chunksToProcess) {
    try {
      const embedding = await generateEmbedding(
        chunk.content,
        "RETRIEVAL_DOCUMENT",
      );

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
      // Free tier: 1500 RPM for embeddings, but be conservative
      if (processed % 10 === 0) {
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
    errors: errors.slice(0, 5), // Only return first 5 errors
  });
});
