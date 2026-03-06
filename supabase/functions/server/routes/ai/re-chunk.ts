/**
 * routes/ai/re-chunk.ts — Manual re-chunking endpoint
 *
 * POST /ai/re-chunk
 *   summary_id: UUID (required)
 *   institution_id: UUID (required) — for auth check
 *   options: { maxChunkSize?, minChunkSize?, overlapSize? } (optional)
 *
 * Authorization: CONTENT_WRITE_ROLES (owner, admin, teacher)
 *
 * This endpoint allows admins/teachers to force re-chunking of a
 * summary, e.g. after changing chunking parameters or updating content.
 * It's synchronous (waits for completion) unlike the fire-and-forget
 * auto-ingest hooks.
 *
 * Fase 5 — Issue #30, sub-task 5.6
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import { autoChunkAndEmbed } from "../../auto-ingest.ts";

export const aiReChunkRoutes = new Hono();

aiReChunkRoutes.post(`${PREFIX}/ai/re-chunk`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  // Validate required fields
  const summaryId = body.summary_id as string;
  const institutionId = body.institution_id as string;

  if (!isUuid(summaryId)) {
    return err(c, "summary_id must be a valid UUID", 400);
  }
  if (!isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  // Authorization: must have write role in this institution
  const roleCheck = await requireInstitutionRole(
    db, user.id, institutionId, CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck)) {
    return err(c, roleCheck.message, roleCheck.status);
  }

  // Verify summary belongs to this institution
  const { data: instId } = await db.rpc("resolve_parent_institution", {
    p_table: "summaries",
    p_id: summaryId,
  });

  if (!instId || instId !== institutionId) {
    return err(c, "Summary does not belong to this institution", 403);
  }

  // Parse optional chunking options
  const options = body.options as Record<string, number> | undefined;
  const chunkOptions = options ? {
    maxChunkSize: typeof options.maxChunkSize === "number" ? options.maxChunkSize : undefined,
    minChunkSize: typeof options.minChunkSize === "number" ? options.minChunkSize : undefined,
    overlapSize: typeof options.overlapSize === "number" ? options.overlapSize : undefined,
  } : undefined;

  try {
    const result = await autoChunkAndEmbed(summaryId, institutionId, chunkOptions);
    return ok(c, result);
  } catch (e) {
    console.error(`[Re-Chunk] Failed for summary ${summaryId}:`, (e as Error).message);
    return err(c, `Re-chunk failed: ${(e as Error).message}`, 500);
  }
});
