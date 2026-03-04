/**
 * routes/content/keyword-search.ts — Cross-summary keyword search
 *
 * Endpoint for Keyword Connections v2.
 * Allows professors to search keywords across all summaries in the
 * same institution (optionally filtered by course) for creating
 * cross-summary connections.
 *
 * Endpoint:
 *   GET /keywords/search?q=xxx&exclude_summary_id=yyy&course_id=zzz
 *
 * Returns: { data: SearchResult[] }
 *   Each result: { id, name, summary_id, definition, summary_title }
 *
 * Security: H-5 compliant — resolves institution from caller's
 * active membership. Only returns keywords from that institution.
 *
 * Performance: Single RPC call (search_keywords_by_institution)
 * doing all JOINs in SQL. ~5ms vs ~35ms with 7 sequential queries.
 *
 * Requires: search_keywords_by_institution() RPC function in DB.
 * See migration-search-rpc.sql.
 *
 * Audit fixes applied: F2 (ilike sanitize), F3 (RPC), F4 (error handling).
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

const searchBase = `${PREFIX}/keywords/search`;

/**
 * F2 FIX: Sanitize SQL LIKE wildcard characters from user input.
 * % and _ have special meaning in ILIKE patterns. Removing them
 * prevents a user from sending q=% to match ALL keywords.
 */
function sanitizeLikeQuery(input: string): string {
  return input.replace(/[%_\\]/g, "");
}

/**
 * GET /keywords/search?q=xxx&exclude_summary_id=yyy&course_id=zzz&limit=15
 *
 * Query params:
 *   q                  (required) search term, min 2 chars after sanitization
 *   exclude_summary_id (optional) exclude keywords from this summary
 *   course_id          (optional) limit to keywords in this course
 *   limit              (optional) max results, default 15, max 30
 */
keywordSearchRoutes.get(searchBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── Parse & validate params ───────────────────────────────
  const rawQ = c.req.query("q")?.trim();
  if (!rawQ || rawQ.length < 2) {
    return err(c, "Query param 'q' required, min 2 characters", 400);
  }

  // F2 FIX: Sanitize LIKE wildcards
  const q = sanitizeLikeQuery(rawQ);
  if (q.length < 2) {
    return err(c, "Search query too short after sanitization", 400);
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

  // ── Step 2: RPC call (F3 FIX: single query, ~5ms) ────────
  const { data, error: rpcError } = await db.rpc(
    "search_keywords_by_institution",
    {
      p_institution_id: institutionId,
      p_query: q,
      p_exclude_summary_id: excludeSummaryId,
      p_course_id: courseId,
      p_limit: limit,
    },
  );

  // F4 FIX: Explicit error handling (not swallowed)
  if (rpcError) {
    console.error(
      "[KeywordSearch] RPC search_keywords_by_institution failed:",
      rpcError.message,
    );
    return err(c, `Keyword search failed: ${rpcError.message}`, 500);
  }

  return ok(c, data || []);
});
