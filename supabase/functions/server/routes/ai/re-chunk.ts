/**
 * routes/ai/re-chunk.ts — Manual re-chunking endpoint
 *
 * POST /ai/re-chunk
 *   Body: { summary_id: UUID, institution_id: UUID, options?: ChunkOptions }
 *   Auth: CONTENT_WRITE_ROLES (owner, admin, professor)
 *
 * Triggers autoChunkAndEmbed() for a specific summary.
 * Use case: professor edited a summary and wants to force re-chunking,
 * or admin wants to re-chunk with different parameters.
 *
 * Rate limited by aiRateLimitMiddleware in index.ts (POST → 20 req/hr).
 *
 * Security:
 *   - PF-02: institution_id required + role check
 *   - PF-05: DB query (role check + cross-institution) before Gemini calls
 *   - Cross-institution: verifies summary belongs to the given institution
 *
 * Note: This file creates the route handler but does NOT mount it.
 * Mounting happens in sub-task 5.7 (routes/ai/index.ts).
 *
 * Fase 5, sub-task 5.6 — Issue #30
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, getAdminClient, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid, isNum } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import { autoChunkAndEmbed } from "../../auto-ingest.ts";
import type { ChunkOptions } from "../../chunker.ts";

export const aiReChunkRoutes = new Hono();

aiReChunkRoutes.post(`${PREFIX}/ai/re-chunk`, async (c: Context) => {
  // ── Step 1: Authenticate ─────────────────────────────────────

  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── Step 2: Parse body ───────────────────────────────────────

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  // ── Step 3: Validate required fields ─────────────────────────

  const summaryId = body.summary_id as string;
  if (!isUuid(summaryId)) {
    return err(c, "summary_id is required (UUID)", 400);
  }

  const institutionId = body.institution_id as string;
  if (!isUuid(institutionId)) {
    return err(c, "institution_id is required (UUID)", 400);
  }

  // ── Step 4: Role check (PF-02) ───────────────────────────────
  //
  // PF-05: This DB query validates the JWT cryptographically
  // via PostgREST. It MUST happen before any Gemini API call.

  const roleCheck = await requireInstitutionRole(
    db,
    user.id,
    institutionId,
    CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck)) {
    return err(c, roleCheck.message, roleCheck.status);
  }

  // ── Step 5: Cross-institution validation ─────────────────────
  //
  // Verify the summary belongs to the given institution.
  // Without this check, a professor could re-chunk a summary
  // from a DIFFERENT institution (they'd pass the role check
  // for their own institution, but operate on foreign data).
  //
  // Uses adminClient because the user's RLS might not allow
  // reading summaries.institution_id directly.

  const adminDb = getAdminClient();

  const { data: summaryRow, error: summaryErr } = await adminDb
    .from("summaries")
    .select("institution_id")
    .eq("id", summaryId)
    .single();

  if (summaryErr || !summaryRow) {
    return err(c, "Summary not found", 404);
  }

  if (summaryRow.institution_id !== institutionId) {
    return err(c, "Summary does not belong to this institution", 403);
  }

  // ── Step 6: Parse optional chunking options ──────────────────
  //
  // Only accept known numeric fields. Ignore unexpected fields.
  // The chunker itself clamps values to safe ranges, so we
  // only need type validation here (not range validation).

  let chunkOptions: ChunkOptions | undefined;

  if (body.options && typeof body.options === "object") {
    const opts = body.options as Record<string, unknown>;
    const parsed: ChunkOptions = {};

    if (opts.maxChunkSize !== undefined) {
      if (!isNum(opts.maxChunkSize) || opts.maxChunkSize <= 0) {
        return err(c, "options.maxChunkSize must be a positive number", 400);
      }
      parsed.maxChunkSize = opts.maxChunkSize;
    }

    if (opts.minChunkSize !== undefined) {
      if (!isNum(opts.minChunkSize) || opts.minChunkSize <= 0) {
        return err(c, "options.minChunkSize must be a positive number", 400);
      }
      parsed.minChunkSize = opts.minChunkSize;
    }

    if (opts.overlapSize !== undefined) {
      if (!isNum(opts.overlapSize) || opts.overlapSize < 0) {
        return err(c, "options.overlapSize must be a non-negative number", 400);
      }
      parsed.overlapSize = opts.overlapSize;
    }

    // Only pass options if at least one field was provided
    if (Object.keys(parsed).length > 0) {
      chunkOptions = parsed;
    }
  }

  // ── Step 7: Execute auto-ingest ───────────────────────────────
  //
  // autoChunkAndEmbed throws on fatal errors (summary not found,
  // INSERT failed) but absorbs embedding failures. We catch
  // throws and return 500.

  try {
    const result = await autoChunkAndEmbed(
      summaryId,
      institutionId,
      chunkOptions,
    );

    return ok(c, result);
  } catch (e) {
    const message = (e as Error).message || "Auto-ingest failed";
    console.error(`[re-chunk] ${message}`);
    return err(c, message, 500);
  }
});
