/**
 * routes/content/keywords-batch.ts — Batch keywords by summary_id
 *
 * ADR-003 Capa B: Eliminates the N+1 pattern where the frontend had to:
 *   1. GET /keywords?summary_id=xxx  × N                → N keywords requests
 *   Total: N HTTP requests (up to 25+ in SectionStudyPlanView)
 *
 * New pattern:
 *   1. GET /keywords-batch?summary_ids=id1,id2,...     → ALL keywords
 *   Total: 1 HTTP request (batches up to 50 summary_ids)
 *
 * HOW IT WORKS:
 *   Accepts comma-separated summary UUIDs, queries keywords table
 *   with .in("summary_id", summary_ids).
 *   PostgreSQL optimizes this with index scan.
 *   Returns keywords grouped by summary_id for frontend convenience.
 *
 * SECURITY:
 *   - Authenticated (same as all Axon endpoints)
 *   - RLS filters to active, non-deleted keywords automatically
 *   - Max 50 summary_ids per request (prevents abuse)
 *
 * RESPONSE FORMAT:
 *   { keywords_by_summary: { summary_id_1: [{...}, ...], summary_id_2: [...], ... }, count: N }
 *
 * FILE: supabase/functions/server/routes/content/keywords-batch.ts
 * REPO: Matraca130/axon-backend
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import type { Context } from "npm:hono";

export const keywordsBatchRoutes = new Hono();

const MAX_SUMMARY_IDS = 50;

// ─── GET /keywords-batch?summary_ids=uuid1,uuid2,... ───────────

keywordsBatchRoutes.get(`${PREFIX}/keywords-batch`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  // ── Validate summary_ids ──────────────────────────────
  const raw = c.req.query("summary_ids");
  if (!raw) {
    return err(c, "summary_ids query param is required (comma-separated UUIDs)", 400);
  }

  const summaryIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (summaryIds.length === 0) {
    return err(c, "summary_ids must contain at least one UUID", 400);
  }
  if (summaryIds.length > MAX_SUMMARY_IDS) {
    return err(c, `summary_ids cannot exceed ${MAX_SUMMARY_IDS} items`, 400);
  }

  // Fail-fast UUID validation
  for (const id of summaryIds) {
    if (!isUuid(id)) {
      return err(c, `Invalid UUID in summary_ids: ${id}`, 400);
    }
  }

  // ── Fetch keywords ──────────────────────────────
  const { data, error } = await db
    .from("keywords")
    .select("*")
    .in("summary_id", summaryIds)
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("order_index", { ascending: true });

  if (error) return safeErr(c, "Batch fetch keywords", error);

  // ── Group by summary_id ─────────────────────────
  const bySummary: Record<string, unknown[]> = {};
  for (const id of summaryIds) {
    bySummary[id] = [];
  }
  for (const kw of data ?? []) {
    const summaryId = (kw as any).summary_id;
    if (summaryId && bySummary[summaryId]) {
      bySummary[summaryId].push(kw);
    }
  }

  return ok(c, { keywords_by_summary: bySummary, count: data?.length ?? 0 });
});
