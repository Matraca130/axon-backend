/**
 * routes/content/keyword-search.ts — Cross-summary keyword search
 *
 * NEW endpoint for Keyword Connections v2.
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
 * Performance: 5 indexed queries through the content hierarchy.
 * At Axon's current scale (<10K keywords/institution) this completes
 * in <50ms. Future optimization: replace with a single RPC that
 * does the join in SQL.
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

const searchBase = `${PREFIX}/keywords/search`;

/**
 * GET /keywords/search?q=xxx&exclude_summary_id=yyy&course_id=zzz&limit=15
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

  const excludeSummaryId = c.req.query("exclude_summary_id");
  const courseId = c.req.query("course_id");
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

  // ── Step 2: Traverse hierarchy → collect summary IDs ──────
  // courses → semesters → sections → topics → summaries
  // Each query is indexed on its FK, ~3-5ms each.

  // 2a. Courses in this institution
  let courseQuery = db
    .from("courses")
    .select("id")
    .eq("institution_id", institutionId)
    .is("deleted_at", null);

  if (courseId) {
    courseQuery = courseQuery.eq("id", courseId);
  }

  const { data: courses, error: courseErr } = await courseQuery;
  if (courseErr) return err(c, `Courses fetch failed: ${courseErr.message}`, 500);
  if (!courses || courses.length === 0) return ok(c, []);

  const courseIds = courses.map((r: any) => r.id);

  // 2b. Semesters
  const { data: semesters } = await db
    .from("semesters")
    .select("id")
    .in("course_id", courseIds)
    .is("deleted_at", null);

  if (!semesters || semesters.length === 0) return ok(c, []);
  const semesterIds = semesters.map((r: any) => r.id);

  // 2c. Sections
  const { data: sections } = await db
    .from("sections")
    .select("id")
    .in("semester_id", semesterIds)
    .is("deleted_at", null);

  if (!sections || sections.length === 0) return ok(c, []);
  const sectionIds = sections.map((r: any) => r.id);

  // 2d. Topics
  const { data: topics } = await db
    .from("topics")
    .select("id")
    .in("section_id", sectionIds)
    .is("deleted_at", null);

  if (!topics || topics.length === 0) return ok(c, []);
  const topicIds = topics.map((r: any) => r.id);

  // 2e. Summaries (also fetch title for enrichment)
  const { data: summaries } = await db
    .from("summaries")
    .select("id, title")
    .in("topic_id", topicIds)
    .is("deleted_at", null);

  if (!summaries || summaries.length === 0) return ok(c, []);

  const summaryIds = summaries.map((r: any) => r.id);
  const titleMap = new Map<string, string>(
    summaries.map((r: any) => [r.id, r.title]),
  );

  // ── Step 3: Search keywords by name ───────────────────────
  let kwQuery = db
    .from("keywords")
    .select("id, name, summary_id, definition")
    .ilike("name", `%${q}%`)
    .in("summary_id", summaryIds)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .limit(limit);

  if (excludeSummaryId) {
    kwQuery = kwQuery.neq("summary_id", excludeSummaryId);
  }

  const { data: keywords, error: kwErr } = await kwQuery;
  if (kwErr) return err(c, `Keyword search failed: ${kwErr.message}`, 500);

  // ── Step 4: Enrich with summary title ─────────────────────
  const results = (keywords || []).map((kw: any) => ({
    id: kw.id,
    name: kw.name,
    summary_id: kw.summary_id,
    definition: kw.definition,
    summary_title: titleMap.get(kw.summary_id) || null,
  }));

  return ok(c, results);
});
