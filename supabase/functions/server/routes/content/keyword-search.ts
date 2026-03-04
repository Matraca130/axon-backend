/**
 * routes/content/keyword-search.ts — Cross-summary keyword search
 *
 * GET /keywords/search?q=xxx&institution_id=yyy&exclude_summary_id=zzz
 *
 * Why a separate route instead of extending GET /keywords:
 *   The factory-generated GET /keywords requires summary_id as parentKey.
 *   A request with ?search=xxx but no summary_id would be rejected with
 *   400 by the factory before our code runs. Separate route = zero conflict.
 *
 * Institution scoping: Uses summaries.institution_id (denormalized column
 * from migration 20260304_06). Falls back to user's active membership.
 *
 * KC-V2: Created for the Keyword Connections panel search feature.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";

export const keywordSearchRoutes = new Hono();

/**
 * N-8 pattern: escape SQL wildcards in user input.
 * Inlined to avoid cross-module dependency on search/helpers.ts.
 */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

keywordSearchRoutes.get(`${PREFIX}/keywords/search`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── Parse & validate query params ──────────────────────────
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) {
    return err(c, "Search query must be at least 2 characters", 400);
  }

  const excludeSummaryId = c.req.query("exclude_summary_id") ?? null;
  let limit = parseInt(c.req.query("limit") ?? "20", 10);
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 50) limit = 50;

  // ── Resolve institution ────────────────────────────────────
  // Priority: explicit param > resolve from exclude_summary_id > user membership
  let institutionId: string | null = null;

  const explicitInstId = c.req.query("institution_id");
  if (explicitInstId && isUuid(explicitInstId)) {
    institutionId = explicitInstId;
  } else if (excludeSummaryId && isUuid(excludeSummaryId)) {
    // Resolve from summary's denormalized institution_id
    const { data: summary } = await db
      .from("summaries")
      .select("institution_id")
      .eq("id", excludeSummaryId)
      .single();
    institutionId = summary?.institution_id ?? null;
  }

  if (!institutionId) {
    // Fallback: user's first active membership
    const { data: membership } = await db
      .from("memberships")
      .select("institution_id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .limit(1)
      .single();
    institutionId = membership?.institution_id ?? null;
  }

  if (!institutionId) {
    return err(c, "Cannot resolve institution. Provide institution_id or ensure active membership.", 400);
  }

  // ── Verify membership ──────────────────────────────────────
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  // ── Search keywords ────────────────────────────────────────
  // Uses summaries.institution_id (denormalized) for scoping.
  // No 6-table JOIN needed.
  const escaped = escapeLike(q);

  let query = db
    .from("keywords")
    .select("id, name, definition, summary_id, summaries!inner(title, institution_id)")
    .ilike("name", `%${escaped}%`)
    .eq("summaries.institution_id", institutionId)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .limit(limit);

  // Exclude keywords from the summary being viewed
  if (excludeSummaryId && isUuid(excludeSummaryId)) {
    query = query.neq("summary_id", excludeSummaryId);
  }

  const { data: keywords, error } = await query;

  if (error) {
    return err(c, `Keyword search failed: ${error.message}`, 500);
  }

  // ── Flatten response (remove nested summaries object) ──────
  const results = (keywords ?? []).map((kw: any) => ({
    id: kw.id,
    name: kw.name,
    definition: kw.definition,
    summary_id: kw.summary_id,
    summary_title: kw.summaries?.title ?? null,
  }));

  return ok(c, { items: results, total: results.length, query: q });
});
