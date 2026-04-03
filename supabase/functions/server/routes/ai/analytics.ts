/**
 * routes/ai/analytics.ts — RAG analytics + embedding coverage
 *
 * GET /ai/rag-analytics?institution_id=UUID&from=ISO&to=ISO
 *   Returns aggregated query metrics for the institution.
 *   Defaults: from = 7 days ago, to = now (handled by RPC defaults)
 *
 * GET /ai/embedding-coverage?institution_id=UUID
 *   Returns what % of chunks have embeddings for the institution.
 *
 * Auth: admin/owner role required for both endpoints.
 * Both use SECURITY DEFINER RPCs — role validation happens HERE in TS,
 * not in the SQL function. This avoids depending on chunks/summaries RLS.
 *
 * These are GET routes, so they bypass the AI rate limit middleware
 * in index.ts (which only limits POST requests).
 *
 * Fase 4 (T-03): Query logging + feedback loop
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
} from "../../auth-helpers.ts";

export const aiAnalyticsRoutes = new Hono();

// ──────────────────────────────────────────────────────────────────────
// GET /ai/rag-analytics
//
// Query params:
//   institution_id (required) — UUID of the institution
//   from (optional)           — ISO 8601 start date
//   to (optional)             — ISO 8601 end date
//
// Returns a single object with aggregated metrics.
// ──────────────────────────────────────────────────────────────────────

aiAnalyticsRoutes.get(`${PREFIX}/ai/rag-analytics`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── Validate institution_id ────────────────────────────────
  const institutionId = c.req.query("institution_id");
  if (!isUuid(institutionId))
    return err(c, "institution_id query param is required (valid UUID)", 400);

  // ── Verify admin/owner role ────────────────────────────────
  const roleCheck = await requireInstitutionRole(
    db, user.id, institutionId!, ["owner", "admin"],
  );
  if (isDenied(roleCheck))
    return err(c, roleCheck.message, roleCheck.status);

  // ── Parse optional date range ─────────────────────────────
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;

  // Validate date formats if provided
  if (from && isNaN(Date.parse(from)))
    return err(c, "'from' must be a valid ISO 8601 date", 400);
  if (to && isNaN(Date.parse(to)))
    return err(c, "'to' must be a valid ISO 8601 date", 400);

  // ── Call RPC ──────────────────────────────────────────────
  // RPC has defaults: from = now()-7d, to = now()
  // We only pass them if the user explicitly provided values.
  const rpcParams: Record<string, unknown> = {
    p_institution_id: institutionId,
  };
  if (from) rpcParams.p_from = from;
  if (to) rpcParams.p_to = to;

  // SEC-S9B: Use admin client for SECURITY DEFINER RPCs
  const { data, error } = await getAdminClient().rpc("rag_analytics_summary", rpcParams);

  if (error)
    return safeErr(c, "Analytics query", error);

  // RPC returns a single row as an array; extract it
  const result = Array.isArray(data) ? data[0] : data;
  return ok(c, result || {
    total_queries: 0,
    avg_similarity: null,
    avg_latency_ms: null,
    positive_feedback: 0,
    negative_feedback: 0,
    zero_result_queries: 0,
  });
});

// ──────────────────────────────────────────────────────────────────────
// GET /ai/embedding-coverage
//
// Query params:
//   institution_id (required) — UUID of the institution
//
// Returns: { total_chunks, chunks_with_embedding, coverage_pct }
// ──────────────────────────────────────────────────────────────────────

aiAnalyticsRoutes.get(`${PREFIX}/ai/embedding-coverage`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── Validate institution_id ────────────────────────────────
  const institutionId = c.req.query("institution_id");
  if (!isUuid(institutionId))
    return err(c, "institution_id query param is required (valid UUID)", 400);

  // ── Verify admin/owner role ────────────────────────────────
  const roleCheck = await requireInstitutionRole(
    db, user.id, institutionId!, ["owner", "admin"],
  );
  if (isDenied(roleCheck))
    return err(c, roleCheck.message, roleCheck.status);

  // ── Call RPC ──────────────────────────────────────────────
  // SEC-S9B: Use admin client for SECURITY DEFINER RPCs
  const { data, error } = await getAdminClient().rpc("rag_embedding_coverage", {
    p_institution_id: institutionId,
  });

  if (error)
    return safeErr(c, "Coverage query", error);

  const result = Array.isArray(data) ? data[0] : data;
  return ok(c, result || {
    total_chunks: 0,
    chunks_with_embedding: 0,
    coverage_pct: 0.0,
  });
});
