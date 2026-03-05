/**
 * routes/ai/feedback.ts — RAG feedback endpoint
 *
 * PATCH /ai/rag-feedback
 *   log_id: UUID (required, the rag_query_log entry to update)
 *   feedback: 1 | -1 (required, thumbs up or down)
 *
 * Security:
 *   - Authenticated users only
 *   - Uses user's DB client (respects RLS)
 *   - RLS policy rag_log_update_feedback ensures users can only
 *     update their own log entries
 *
 * Why PATCH (not POST):
 *   We're updating a single field (feedback) on an existing resource.
 *   PATCH is semantically correct for partial updates.
 *
 * Fase 4 (T-03): Query logging + feedback loop
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";

export const aiFeedbackRoutes = new Hono();

aiFeedbackRoutes.patch(`${PREFIX}/ai/rag-feedback`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  // ── Validate log_id ───────────────────────────────────────
  if (!isUuid(body.log_id))
    return err(c, "log_id is required (valid UUID)", 400);
  const logId = body.log_id as string;

  // ── Validate feedback value ────────────────────────────────
  const feedback = body.feedback;
  if (feedback !== 1 && feedback !== -1)
    return err(c, "feedback must be 1 (thumbs up) or -1 (thumbs down)", 400);

  // ── Update via user's client (RLS enforces ownership) ──────
  const { data, error } = await db
    .from("rag_query_log")
    .update({ feedback })
    .eq("id", logId)
    .select("id, feedback, created_at")
    .single();

  if (error) {
    // RLS will cause a "not found" error if the user doesn't own the log
    if (error.code === "PGRST116") {
      return err(c, "Log entry not found or not owned by you", 404);
    }
    return err(c, `Failed to update feedback: ${error.message}`, 500);
  }

  return ok(c, { updated: data });
});
