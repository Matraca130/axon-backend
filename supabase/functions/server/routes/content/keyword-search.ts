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
 * Fallback: If the RPC doesn't exist (migration not applied), falls
 * back to get_institution_summary_ids + PostgREST ILIKE query.
 * Slower (~20ms) but functional without the migration.
 *
 * F3 FIX: Both RPC and fallback now filter by status = 'published'.
 * Only keywords from published summaries are returned.
 *
 * Route naming: Uses flat `/keyword-search` instead of nested
 * `/keywords/search` to follow Axon convention and avoid collision
 * with the CRUD factory's `GET /keywords/:id`.
 *
 * Safety: limit capped at 30, query min 2 chars.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
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

  // ── Parse & validate params ─────────────────────────────
  const q = c.req.query("q")?.trim();
  if (!q || q.length < 2) {
    return err(c, "Query param 'q' required, min 2 characters", 400);
  }

  const excludeSummaryId = c.req.query("exclude_summary_id") || null;
  const courseId = c.req.query("course_id") || null;
  let limit = parseInt(c.req.query("limit") ?? "15", 10);
  if (isNaN(limit) || limit < 1) limit = 15;
  if (limit > 30) limit = 30;

  // ── Step 1: Resolve caller's institution ──────────────
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
  // F3 FIX: RPC now includes s.status = 'published' filter
  // (applied in migration 20260306_02).
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

  // ── Step 2b: PostgREST fallback if RPC doesn't exist ────
  // This handles the case where the migration hasn't been applied yet.
  // Once the RPC is deployed, this path is never hit.
  if (rpcError) {
    console.warn(
      "[keyword-search] RPC failed, using PostgREST fallback:",
      rpcError.message,
    );

    try {
      // Phase 1: Get all summary IDs for this institution
      // Uses get_institution_summary_ids RPC (exists since 20260304_05)
      const { data: summaryRows, error: sumError } = await db.rpc(
        "get_institution_summary_ids",
        { p_institution_id: institutionId },
      );

      if (sumError || !summaryRows || summaryRows.length === 0) {
        return ok(c, []);
      }

      let summaryIds: string[] = summaryRows.map(
        (r: { summary_id: string }) => r.summary_id,
      );

      // F3 FIX: Filter to only published summaries
      // get_institution_summary_ids returns ALL summaries (including drafts)
      // so we must filter by status here for student safety.
      const { data: publishedRows } = await db
        .from("summaries")
        .select("id")
        .in("id", summaryIds)
        .eq("status", "published")
        .eq("is_active", true);
      summaryIds = (publishedRows || []).map((s: { id: string }) => s.id);

      // Optional: filter by course_id
      if (courseId) {
        const { data: courseSumRows } = await db.rpc(
          "get_course_summary_ids",
          { p_course_id: courseId },
        );
        if (courseSumRows && courseSumRows.length > 0) {
          const courseSet = new Set(
            courseSumRows.map((r: { summary_id: string }) => r.summary_id),
          );
          summaryIds = summaryIds.filter((id) => courseSet.has(id));
        } else {
          summaryIds = [];
        }
      }

      // Exclude specific summary
      if (excludeSummaryId) {
        summaryIds = summaryIds.filter((id) => id !== excludeSummaryId);
      }

      if (summaryIds.length === 0) {
        return ok(c, []);
      }

      // Phase 2: Search keywords by name within those summaries
      const { data: kwResults, error: kwError } = await db
        .from("keywords")
        .select("id, name, summary_id, definition")
        .in("summary_id", summaryIds)
        .ilike("name", `%${q}%`)
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .limit(limit);

      if (kwError) {
        return safeErr(c, "Keyword search fallback", kwError);
      }

      // Phase 3: Enrich with summary_title
      const uniqueSummaryIds = [
        ...new Set((kwResults || []).map((k: any) => k.summary_id)),
      ];
      let titleMap: Record<string, string> = {};
      if (uniqueSummaryIds.length > 0) {
        const { data: summaries } = await db
          .from("summaries")
          .select("id, title")
          .in("id", uniqueSummaryIds);
        if (summaries) {
          for (const s of summaries) {
            titleMap[s.id] = s.title || "";
          }
        }
      }

      const enriched = (kwResults || []).map((k: any) => ({
        ...k,
        summary_title: titleMap[k.summary_id] || "",
      }));

      return ok(c, enriched);
    } catch (fallbackErr: any) {
      console.error("[keyword-search] Fallback error:", fallbackErr);
      return safeErr(c, "Keyword search", fallbackErr);
    }
  }

  return ok(c, results || []);
});
