/**
 * routes/ai/reanalyze.ts — Batch re-analysis of topics with outdated analysis versions
 *
 * POST /ai/reanalyze-topics
 *   institution_id: UUID (required)
 *   course_id: UUID (optional — scope to a single course)
 *   force: boolean (optional — re-analyze even if version is current)
 *
 * Maintenance endpoint for when the AI prompt, model, or difficulty formula
 * changes (bumping CURRENT_ANALYSIS_VERSION in topic-analyzer.ts).
 *
 * Finds topics that need re-analysis (outdated version or never analyzed),
 * resolves their first summary, and fires analyzeTopicDifficulty() for each
 * in a fire-and-forget manner.
 *
 * Security:
 *   - Requires professor/admin/owner role (CONTENT_WRITE_ROLES)
 *   - Institution-scoped: only topics belonging to the caller's institution
 *   - Rate limited by AI middleware (20 req/hour)
 *   - Max 50 topics per call to prevent abuse
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, getAdminClient, ok, err, safeJson, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import {
  analyzeTopicDifficulty,
  CURRENT_ANALYSIS_VERSION,
} from "../../topic-analyzer.ts";

export const aiReanalyzeRoutes = new Hono();

const MAX_TOPICS_PER_CALL = 50;

aiReanalyzeRoutes.post(`${PREFIX}/ai/reanalyze-topics`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  // ── Validate institution_id ────────────────────────────────────
  const institutionId = body.institution_id as string;
  if (!isUuid(institutionId))
    return err(c, "institution_id is required (UUID)", 400);

  // ── Role check (professor/admin/owner) ─────────────────────────
  const roleCheck = await requireInstitutionRole(
    db, user.id, institutionId, CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck))
    return err(c, roleCheck.message, roleCheck.status);

  // ── Parse optional params ──────────────────────────────────────
  const courseId = body.course_id as string | undefined;
  if (courseId && !isUuid(courseId))
    return err(c, "course_id must be a valid UUID", 400);

  const force = body.force === true;

  const adminDb = getAdminClient();

  // ── Build topic query ──────────────────────────────────────────
  // Topics belong to: topics -> sections -> semesters -> courses
  // We need institution scoping via courses.institution_id
  let query = adminDb
    .from("topics")
    .select(`
      id, analysis_version, last_analyzed_at,
      sections!inner (
        semesters!inner (
          courses!inner ( id, institution_id )
        )
      )
    `)
    .eq("sections.semesters.courses.institution_id", institutionId);

  // Scope to course if provided
  if (courseId) {
    query = query.eq("sections.semesters.courses.id", courseId);
  }

  // Unless force=true, only fetch outdated/never-analyzed topics
  if (!force) {
    // PostgREST OR filter: analysis_version < current OR last_analyzed_at IS NULL
    query = query.or(
      `analysis_version.lt.${CURRENT_ANALYSIS_VERSION},last_analyzed_at.is.null`,
    );
  }

  const { data: topics, error: fetchErr } = await query;

  if (fetchErr) {
    console.error(`[Reanalyze] Topic query failed: ${fetchErr.message}`);
    return err(c, `Failed to query topics: ${fetchErr.message}`, 500);
  }

  if (!topics || topics.length === 0) {
    return ok(c, {
      triggered: 0,
      already_current: 0,
      total: 0,
      current_version: CURRENT_ANALYSIS_VERSION,
      message: "No topics found matching criteria",
    });
  }

  // ── Enforce max topics per call ────────────────────────────────
  if (topics.length > MAX_TOPICS_PER_CALL) {
    return err(
      c,
      `Too many topics (${topics.length}). Maximum ${MAX_TOPICS_PER_CALL} per call. ` +
        `Use course_id to narrow the scope.`,
      400,
    );
  }

  // ── Separate current vs outdated (when force=true, all are "triggered") ──
  let alreadyCurrent = 0;
  const topicsToAnalyze: Array<{ id: string }> = [];

  for (const topic of topics) {
    const isUpToDate =
      topic.analysis_version === CURRENT_ANALYSIS_VERSION &&
      topic.last_analyzed_at !== null;

    if (isUpToDate && !force) {
      alreadyCurrent++;
    } else {
      topicsToAnalyze.push({ id: topic.id as string });
    }
  }

  if (topicsToAnalyze.length === 0) {
    return ok(c, {
      triggered: 0,
      already_current: alreadyCurrent,
      total: topics.length,
      current_version: CURRENT_ANALYSIS_VERSION,
      message: "All topics are already at current analysis version",
    });
  }

  // ── Find first summary for each topic ──────────────────────────
  // Batch query: get the first non-deleted summary per topic
  const topicIds = topicsToAnalyze.map((t) => t.id);

  const { data: summaries, error: sumErr } = await adminDb
    .from("summaries")
    .select("id, topic_id")
    .in("topic_id", topicIds)
    .is("deleted_at", null)
    .order("order_index", { ascending: true });

  if (sumErr) {
    console.error(`[Reanalyze] Summary query failed: ${sumErr.message}`);
    return err(c, `Failed to query summaries: ${sumErr.message}`, 500);
  }

  // Build map: topic_id -> first summary_id (take first occurrence per topic)
  const topicSummaryMap = new Map<string, string>();
  if (summaries) {
    for (const s of summaries) {
      const tid = s.topic_id as string;
      if (!topicSummaryMap.has(tid)) {
        topicSummaryMap.set(tid, s.id as string);
      }
    }
  }

  // ── Fire analysis for each topic (fire-and-forget) ─────────────
  let triggered = 0;
  let skipped = 0;

  for (const topic of topicsToAnalyze) {
    const summaryId = topicSummaryMap.get(topic.id);
    if (!summaryId) {
      // No summary available for this topic — skip
      skipped++;
      continue;
    }

    // Fire-and-forget: don't await, let it run in background
    analyzeTopicDifficulty(summaryId, topic.id, institutionId).catch((e) => {
      console.error(
        `[Reanalyze] Analysis failed for topic=${topic.id}: ${(e as Error).message}`,
      );
    });

    triggered++;
  }

  return ok(c, {
    triggered,
    skipped,
    already_current: alreadyCurrent,
    total: topics.length,
    current_version: CURRENT_ANALYSIS_VERSION,
    message: `Analysis triggered for ${triggered} topics` +
      (skipped > 0 ? ` (${skipped} skipped — no summary)` : ""),
  });
});
