/**
 * routes/study/intelligence.ts — Topic difficulty intelligence for study planning
 *
 * Provides enriched topic metadata for the study scheduling engine on the frontend.
 * Uses pre-computed difficulty analysis from topic-analyzer.ts.
 *
 * Endpoints:
 *   GET  /study-intelligence?course_id=xxx — Topic difficulty metadata for a course
 *   POST /study-intelligence/analyze-batch — Trigger batch analysis (professor+)
 *
 * FILE: supabase/functions/server/routes/study/intelligence.ts
 * REPO: Matraca130/axon-backend
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, getAdminClient, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { analyzeTopicDifficulty, CURRENT_ANALYSIS_VERSION } from "../../topic-analyzer.ts";

export const intelligenceRoutes = new Hono();

const LOG_PREFIX = "[Study Intelligence]";

// ═══════════════════════════════════════════════════════════════════
// GET /study-intelligence?course_id=xxx&include_prerequisites=true&include_similar=true
//
// Returns difficulty metadata for all topics the student has access to
// within a course. Used by the study plan wizard.
// ═══════════════════════════════════════════════════════════════════

intelligenceRoutes.get(`${PREFIX}/study-intelligence`, async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── Validate course_id (required) ─────────────────────────────
  const courseId = c.req.query("course_id");
  if (!courseId || !isUuid(courseId)) {
    return err(c, "course_id query parameter is required and must be a valid UUID", 400);
  }

  const includePrerequisites = c.req.query("include_prerequisites") === "true";
  const includeSimilar = c.req.query("include_similar") === "true";

  // ── Resolve institution from course ───────────────────────────
  const { data: course, error: courseErr } = await db
    .from("courses")
    .select("id, institution_id")
    .eq("id", courseId)
    .single();

  if (courseErr || !course) {
    return err(c, "Course not found or access denied", 404);
  }

  const institutionId = course.institution_id as string;

  // ── Role check: any member can read ───────────────────────────
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status as 400 | 403);

  // ── Fetch topics with section/semester chain ──────────────────
  // topics → sections → semesters, filtered by course
  const { data: topics, error: topicsErr } = await db
    .from("topics")
    .select(`
      id,
      name,
      difficulty_estimate,
      estimated_study_minutes,
      bloom_level,
      abstraction_level,
      concept_density,
      interrelation_score,
      cohort_difficulty,
      analysis_version,
      last_analyzed_at,
      sections!inner (
        id,
        name,
        semesters!inner (
          id,
          course_id
        )
      )
    `)
    .eq("sections.semesters.course_id", courseId)
    .order("name");

  if (topicsErr) {
    console.error(`${LOG_PREFIX} Topics query failed: ${topicsErr.message}`);
    return err(c, "Failed to fetch topics", 500);
  }

  if (!topics || topics.length === 0) {
    return ok(c, {
      topics: [],
      course_stats: {
        avg_difficulty: 0,
        total_estimated_minutes: 0,
        topics_analyzed: 0,
        topics_pending_analysis: 0,
      },
    });
  }

  // ── Build response topics ─────────────────────────────────────
  const responseTopic = await Promise.all(
    topics.map(async (t: Record<string, unknown>) => {
      const section = t.sections as Record<string, unknown> | null;
      const sectionName = section ? (section.name as string) : null;

      const entry: Record<string, unknown> = {
        id: t.id,
        name: t.name,
        section_name: sectionName,
        difficulty_estimate: t.difficulty_estimate ?? null,
        estimated_study_minutes: t.estimated_study_minutes ?? null,
        bloom_level: t.bloom_level ?? null,
        abstraction_level: t.abstraction_level ?? null,
        concept_density: t.concept_density ?? null,
        interrelation_score: t.interrelation_score ?? null,
        cohort_difficulty: t.cohort_difficulty ?? null,
      };

      // ── Optional: prerequisite chain ────────────────────────
      if (includePrerequisites) {
        const { data: prereqs } = await db
          .from("topic_prerequisites")
          .select("prerequisite_topic_id")
          .eq("topic_id", t.id as string);

        entry.prerequisite_topic_ids = prereqs
          ? prereqs.map((p: Record<string, unknown>) => p.prerequisite_topic_id)
          : [];
      }

      // ── Optional: similar topics via RPC ────────────────────
      if (includeSimilar) {
        const adminDb = getAdminClient();
        const { data: similar, error: simErr } = await adminDb.rpc(
          "find_similar_topics",
          { p_topic_id: t.id as string, p_limit: 5 },
        );

        if (simErr) {
          console.warn(
            `${LOG_PREFIX} find_similar_topics RPC failed for topic=${t.id}: ${simErr.message}`,
          );
          entry.similar_topics = [];
        } else {
          entry.similar_topics = (similar ?? []).map(
            (s: Record<string, unknown>) => ({
              topic_id: s.topic_id,
              name: s.name,
              similarity: s.similarity,
            }),
          );
        }
      }

      return entry;
    }),
  );

  // ── Compute course stats ──────────────────────────────────────
  const analyzed = topics.filter(
    (t: Record<string, unknown>) => t.difficulty_estimate !== null,
  );
  const pendingAnalysis = topics.filter(
    (t: Record<string, unknown>) => t.difficulty_estimate === null,
  );

  const avgDifficulty =
    analyzed.length > 0
      ? Math.round(
          (analyzed.reduce(
            (sum: number, t: Record<string, unknown>) =>
              sum + (t.difficulty_estimate as number),
            0,
          ) /
            analyzed.length) *
            100,
        ) / 100
      : 0;

  const totalMinutes = analyzed.reduce(
    (sum: number, t: Record<string, unknown>) =>
      sum + ((t.estimated_study_minutes as number) ?? 0),
    0,
  );

  return ok(c, {
    topics: responseTopic,
    course_stats: {
      avg_difficulty: avgDifficulty,
      total_estimated_minutes: totalMinutes,
      topics_analyzed: analyzed.length,
      topics_pending_analysis: pendingAnalysis.length,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /study-intelligence/analyze-batch
//
// Triggers difficulty analysis for all unanalyzed topics in a course.
// Professor-only (CONTENT_WRITE_ROLES). Fire-and-forget.
// ═══════════════════════════════════════════════════════════════════

intelligenceRoutes.post(`${PREFIX}/study-intelligence/analyze-batch`, async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // ── Parse body ────────────────────────────────────────────────
  const body = await safeJson(c);
  if (!body) return err(c, "Invalid JSON body", 400);

  const courseId = body.course_id as string | undefined;
  if (!courseId || !isUuid(courseId)) {
    return err(c, "course_id is required and must be a valid UUID", 400);
  }

  // ── Resolve institution from course ───────────────────────────
  const { data: course, error: courseErr } = await db
    .from("courses")
    .select("id, institution_id")
    .eq("id", courseId)
    .single();

  if (courseErr || !course) {
    return err(c, "Course not found or access denied", 404);
  }

  const institutionId = course.institution_id as string;

  // ── Role check: professor+ can trigger analysis ───────────────
  const roleCheck = await requireInstitutionRole(
    db,
    user.id,
    institutionId,
    CONTENT_WRITE_ROLES,
  );
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status as 400 | 403);

  // ── Find topics needing analysis (admin client for cross-student data) ──
  const adminDb = getAdminClient();

  const { data: allTopics, error: topicsErr } = await adminDb
    .from("topics")
    .select(`
      id,
      difficulty_estimate,
      analysis_version,
      sections!inner (
        id,
        semesters!inner (
          id,
          course_id
        )
      )
    `)
    .eq("sections.semesters.course_id", courseId);

  if (topicsErr) {
    console.error(`${LOG_PREFIX} Batch query failed: ${topicsErr.message}`);
    return err(c, "Failed to query topics", 500);
  }

  if (!allTopics || allTopics.length === 0) {
    return ok(c, {
      triggered: 0,
      already_analyzed: 0,
      message: "No topics found in this course",
    });
  }

  // ── Partition: needs analysis vs already done ─────────────────
  const needsAnalysis = allTopics.filter(
    (t: Record<string, unknown>) =>
      t.difficulty_estimate === null ||
      (t.analysis_version as number | null) === null ||
      (t.analysis_version as number) < CURRENT_ANALYSIS_VERSION,
  );
  const alreadyAnalyzed = allTopics.length - needsAnalysis.length;

  // ── Fire-and-forget: trigger analysis for each unanalyzed topic ──
  // We need a summary_id per topic to analyze. Fetch the first summary for each.
  if (needsAnalysis.length > 0) {
    const topicIds = needsAnalysis.map((t: Record<string, unknown>) => t.id as string);

    const { data: summaries } = await adminDb
      .from("summaries")
      .select("id, topic_id")
      .in("topic_id", topicIds)
      .order("created_at", { ascending: true });

    // Map: topic_id -> first summary_id
    const topicToSummary = new Map<string, string>();
    if (summaries) {
      for (const s of summaries) {
        const tid = s.topic_id as string;
        if (!topicToSummary.has(tid)) {
          topicToSummary.set(tid, s.id as string);
        }
      }
    }

    // Fire-and-forget each analysis
    for (const topic of needsAnalysis) {
      const topicId = topic.id as string;
      const summaryId = topicToSummary.get(topicId);

      if (!summaryId) {
        console.warn(
          `${LOG_PREFIX} No summary found for topic=${topicId}, skipping analysis`,
        );
        continue;
      }

      // Fire-and-forget — do not await
      analyzeTopicDifficulty(summaryId, topicId, institutionId).catch((e) => {
        console.error(
          `${LOG_PREFIX} Batch analysis failed for topic=${topicId}: ${(e as Error).message}`,
        );
      });
    }

    console.info(
      `${LOG_PREFIX} Batch analysis triggered for ${needsAnalysis.length} topics in course=${courseId}`,
    );
  }

  return ok(c, {
    triggered: needsAnalysis.length,
    already_analyzed: alreadyAnalyzed,
    message:
      needsAnalysis.length > 0
        ? `Analysis started for ${needsAnalysis.length} topics`
        : "All topics already analyzed",
  });
});
