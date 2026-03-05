/**
 * routes/content/keyword-search.ts — Cross-summary keyword search
 *
 * Keyword Connections v2: search keywords across all summaries in
 * the caller's institution (optionally filtered by course).
 *
 * Endpoint:
 *   GET /keyword-search?q=xxx&exclude_summary_id=yyy&course_id=zzz&limit=15
 *
 * Returns: { data: SearchResult[] }
 *   Each result: { id, name, summary_id, definition, summary_title }
 *
 * Security: H-5 compliant — resolves institution from caller's
 * active membership. Only returns keywords from that institution.
 *
 * Performance: Single RPC call `search_keywords_by_institution` (~5ms).
 * Replaces the previous 7-query cascade (~35ms).
 *
 * Route naming: Uses flat `/keyword-search` instead of nested
 * `/keywords/search` to follow Axon convention and avoid collision
 * with the CRUD factory's `GET /keywords/:id`.
 *
 * Safety: limit capped at 30, query min 2 chars.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";

export const keywordSearchRoutes = new Hono();

const searchBase = `${PREFIX}/keyword-search`;

/**
 * GET /keyword-search?q=xxx&exclude_summary_id=yyy&course_id=zzz&limit=15
 *
 * Query params:
 *   q                  (required) search term, min 2 chars
 *   exclude_summary_id (optional) exclude keywords from this summary
 *   course_id          (optional) limit to keywords in this course
 *   limit              (optional) max results, default 15, max 30
 */
keywordSearchRoutes.get(searchBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── Parse & validate params ───────────────────────────────
  const q = c.req.query("q")?.trim();
  if (!q || q.length < 2) {
    return err(c, "Query param 'q' required, min 2 characters", 400);
  }

  const excludeSummaryId = c.req.query("exclude_summary_id") || null;
  const courseId = c.req.query("course_id") || null;
  let limit = parseInt(c.req.query("limit") ?? "15", 10);
  if (isNaN(limit) || limit < 1) limit = 15;
  if (limit > 30) limit = 30;

  // ── Step 1: Resolve caller's institution ──────────────────
  const { data: membership, error: memberError } = await db
    .from("memberships")
    .select("institution_id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .single();

  if (memberError || !membership) {
    return err(c, "No active institution membership found", 403);
  }

  const institutionId = membership.institution_id;

  // Verify at least read access
  const roleCheck = await requireInstitutionRole(
    db, user.id, institutionId, ALL_ROLES,
  );
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  // ── Step 2: Search via RPC (single SQL JOIN, ~5ms) ────────
  // Uses the `search_keywords_by_institution` function created by
  // migration-search-rpc.sql. Replaces the previous 7-query cascade.
  const { data: results, error: rpcError } = await db.rpc(
    "search_keywords_by_institution",
    {
      p_institution_id: institutionId,
      p_query: q,
      p_exclude_summary_id: excludeSummaryId,
      p_course_id: courseId,
      p_limit: limit,
    },
  );

  if (rpcError) {
    console.error("[keyword-search] RPC error:", rpcError);
    return err(c, `Keyword search failed: ${rpcError.message}`, 500);
  }

  return ok(c, results || []);
});
