/**
 * routes/ai/student-weak-points.ts — Student weak keyword analysis
 *
 * GET /ai/student-weak-points?topic_id=UUID
 *   Returns the student's weakest keywords for a topic, ordered by urgency.
 *   Pure database query — no AI call needed.
 *
 * Auth: any authenticated role within the topic's institution.
 *
 * Logic:
 *   topic -> summaries -> keywords -> subtopics -> bkt_states
 *   Aggregates p_know per keyword, recommends action based on mastery level.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";

export const aiWeakPointsRoutes = new Hono();

// ──────────────────────────────────────────────────────────────────────
// GET /ai/student-weak-points
//
// Query params:
//   topic_id (required) — UUID of the topic to analyze
//
// Returns: { data: WeakPoint[] }  (max 20, sorted by mastery ascending)
// ──────────────────────────────────────────────────────────────────────

interface WeakPoint {
  keyword_id: string;
  name: string;
  mastery: number;
  last_reviewed: string | null;
  recommended_action: "review" | "flashcard" | "quiz";
}

aiWeakPointsRoutes.get(
  `${PREFIX}/ai/student-weak-points`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    // ── Validate topic_id ───────────────────────────────────────
    const topicId = c.req.query("topic_id");
    if (!isUuid(topicId))
      return err(c, "topic_id query param is required (valid UUID)", 400);

    // ── Resolve institution from topic ──────────────────────────
    const { data: institutionId, error: resolveErr } = await db.rpc(
      "resolve_parent_institution",
      { p_table: "topics", p_id: topicId },
    );
    if (resolveErr || !institutionId)
      return err(c, "Could not resolve institution for this topic", 404);

    // ── Verify role (any role is allowed) ───────────────────────
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      institutionId,
      ALL_ROLES,
    );
    if (isDenied(roleCheck))
      return err(c, roleCheck.message, roleCheck.status);

    // ── 1. Fetch active summaries for the topic ─────────────────
    const { data: summaries, error: sumErr } = await db
      .from("summaries")
      .select("id")
      .eq("topic_id", topicId)
      .eq("is_active", true)
      .is("deleted_at", null);

    if (sumErr)
      return err(c, `Failed to fetch summaries: ${sumErr.message}`, 500);

    const summaryIds = (summaries || []).map((s: { id: string }) => s.id);
    if (summaryIds.length === 0) return ok(c, { data: [] });

    // ── 2. Fetch keywords for those summaries ───────────────────
    const { data: keywords, error: kwErr } = await db
      .from("keywords")
      .select("id, name, summary_id")
      .in("summary_id", summaryIds);

    if (kwErr)
      return err(c, `Failed to fetch keywords: ${kwErr.message}`, 500);

    if (!keywords || keywords.length === 0) return ok(c, { data: [] });

    const keywordIds = keywords.map((k: { id: string }) => k.id);

    // ── 3. Fetch subtopics for those keywords ───────────────────
    const { data: subtopics, error: stErr } = await db
      .from("subtopics")
      .select("id, keyword_id")
      .in("keyword_id", keywordIds);

    if (stErr)
      return err(c, `Failed to fetch subtopics: ${stErr.message}`, 500);

    if (!subtopics || subtopics.length === 0) return ok(c, { data: [] });

    // ── 4. Fetch BKT states for the student ─────────────────────
    const subtopicIds = subtopics.map((s: { id: string }) => s.id);
    const { data: bktStates, error: bktErr } = await db
      .from("bkt_states")
      .select("subtopic_id, p_know, total_attempts, last_attempt_at")
      .eq("student_id", user.id)
      .in("subtopic_id", subtopicIds);

    if (bktErr)
      return err(c, `Failed to fetch BKT states: ${bktErr.message}`, 500);

    // ── 5. Build subtopic -> keyword lookup ─────────────────────
    const subtopicToKeyword = new Map<string, string>();
    for (const st of subtopics) {
      subtopicToKeyword.set(st.id, st.keyword_id);
    }

    // ── 6. Build BKT lookup by subtopic_id ──────────────────────
    const bktBySubtopic = new Map<
      string,
      { p_know: number; last_attempt_at: string | null }
    >();
    for (const bkt of bktStates || []) {
      bktBySubtopic.set(bkt.subtopic_id, {
        p_know: bkt.p_know,
        last_attempt_at: bkt.last_attempt_at,
      });
    }

    // ── 7. Aggregate mastery per keyword ────────────────────────
    // Group subtopics by keyword, average their p_know values
    const keywordAgg = new Map<
      string,
      { totalPKnow: number; count: number; lastReviewed: string | null }
    >();

    for (const st of subtopics) {
      const kwId = st.keyword_id;
      const bkt = bktBySubtopic.get(st.id);
      const pKnow = bkt ? bkt.p_know : 0;
      const lastAt = bkt ? bkt.last_attempt_at : null;

      const existing = keywordAgg.get(kwId);
      if (existing) {
        existing.totalPKnow += pKnow;
        existing.count += 1;
        // Keep the most recent review date
        if (
          lastAt &&
          (!existing.lastReviewed || lastAt > existing.lastReviewed)
        ) {
          existing.lastReviewed = lastAt;
        }
      } else {
        keywordAgg.set(kwId, {
          totalPKnow: pKnow,
          count: 1,
          lastReviewed: lastAt,
        });
      }
    }

    // ── 8. Build result array ───────────────────────────────────
    const kwById = new Map(keywords.map((k: { id: string; name: string }) => [k.id, k.name]));
    const results: WeakPoint[] = [];

    for (const [kwId, agg] of keywordAgg) {
      const mastery = agg.count > 0 ? agg.totalPKnow / agg.count : 0;

      // Skip strong areas (mastery >= 0.7)
      if (mastery >= 0.7) continue;

      let recommended_action: WeakPoint["recommended_action"];
      if (mastery < 0.3) {
        recommended_action = "review";
      } else if (mastery < 0.5) {
        recommended_action = "flashcard";
      } else {
        recommended_action = "quiz";
      }

      const name = kwById.get(kwId);
      if (!name) continue; // safety check

      results.push({
        keyword_id: kwId,
        name,
        mastery: Math.round(mastery * 1000) / 1000, // 3 decimal places
        last_reviewed: agg.lastReviewed,
        recommended_action,
      });
    }

    // ── 9. Sort by mastery ascending (weakest first), limit 20 ──
    results.sort((a, b) => a.mastery - b.mastery);
    const top20 = results.slice(0, 20);

    return ok(c, top20);
  },
);
