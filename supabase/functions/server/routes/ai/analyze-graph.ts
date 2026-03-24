/**
 * routes/ai/analyze-graph.ts — Knowledge graph analysis endpoint
 *
 * POST /ai/analyze-knowledge-graph
 *   Analyzes a student's knowledge graph for a topic, identifying
 *   weak areas, strong areas, missing connections, and a study path.
 *
 * Auth: Any active member of the institution (ALL_ROLES).
 *
 * Design decisions:
 *   D1: DB queries BEFORE AI call (PF-05) — fetch keywords, connections,
 *       BKT states first, then send to Claude for analysis.
 *   D2: BKT mastery mapped via subtopics (subtopic -> keyword_id).
 *   D3: Claude analyzes the graph and returns structured JSON.
 *   D4: Connection types constrained to the keyword_connections vocabulary.
 *   D5: summary_text returned in Spanish (platform language).
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import { isUuid } from "../../validate.ts";
import {
  generateText,
  parseClaudeJson,
  GENERATE_MODEL,
} from "../../claude-ai.ts";
import { sanitizeForPrompt, wrapXml } from "../../prompt-sanitize.ts";

export const aiAnalyzeGraphRoutes = new Hono();

// ── Connection types vocabulary (matches keyword_connections.connection_type) ──
const CONNECTION_TYPES = [
  "prerequisito",
  "causa-efecto",
  "mecanismo",
  "dx-diferencial",
  "tratamiento",
  "manifestacion",
  "regulacion",
  "contraste",
  "componente",
  "asociacion",
] as const;

// ── System prompt for Claude analysis ─────────────────────────────────
const SYSTEM_PROMPT = `You are an AI tutor analyzing a medical student's knowledge graph. Given the student's keywords, their mastery levels (p_know from BKT), and the connections between them, provide a comprehensive analysis.

Respond in valid JSON with this exact structure:
{
  "weak_areas": [{ "keyword_id": "uuid", "keyword_name": "string", "mastery": 0.25, "recommendation": "string in Spanish" }],
  "strong_areas": [{ "keyword_id": "uuid", "keyword_name": "string", "mastery": 0.85 }],
  "missing_connections": [{ "from_keyword": "string", "to_keyword": "string", "suggested_type": "string", "reason": "string in Spanish" }],
  "study_path": [{ "step": 1, "action": "review|quiz|flashcard", "keyword_id": "uuid", "reason": "string in Spanish" }],
  "overall_score": 0.65,
  "summary_text": "string in Spanish"
}

Rules:
- weak_areas: keywords with p_know < 0.5, sorted by mastery ascending
- strong_areas: keywords with p_know >= 0.7
- missing_connections: suggest 2-5 connections that should exist based on medical knowledge
- study_path: ordered list of 3-7 steps, starting with weakest areas
- overall_score: weighted average of all keyword masteries
- summary_text: 2-3 sentences in Spanish summarizing the analysis
- All keyword_ids must be valid UUIDs from the provided data
- suggested_type must be one of: ${CONNECTION_TYPES.join(", ")}
- If a keyword has no BKT data, assume mastery = 0.3 (no attempts yet)`;

// ================================================================
// POST /ai/analyze-knowledge-graph
// ================================================================
aiAnalyzeGraphRoutes.post(
  `${PREFIX}/ai/analyze-knowledge-graph`,
  async (c: Context) => {
    // ── Step 1: Auth (PF-05: JWT before any operation) ──────────
    const auth = c.get("auth") ?? await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    // ── Step 2: Validate body ──────────────────────────────────
    const body = await safeJson(c);
    if (!body) return err(c, "Invalid JSON body", 400);

    const topicId = body.topic_id as string;
    if (!isUuid(topicId))
      return err(c, "topic_id is required (valid UUID)", 400);

    // ── Step 3: Resolve institution from topic ─────────────────
    const { data: instId, error: instErr } = await db.rpc(
      "resolve_parent_institution",
      { p_table: "topics", p_id: topicId },
    );

    if (instErr || !instId)
      return err(c, "Topic not found or not linked to an institution", 404);

    // ── Step 4: Verify membership (any role can analyze) ───────
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      instId,
      ALL_ROLES,
    );
    if (isDenied(roleCheck))
      return err(c, roleCheck.message, roleCheck.status);

    // ── Step 5: DB queries BEFORE AI call (PF-05) ──────────────

    // 5a: Get summaries for the topic
    const { data: summaries, error: sumErr } = await db
      .from("summaries")
      .select("id")
      .eq("topic_id", topicId)
      .eq("is_active", true)
      .is("deleted_at", null);

    if (sumErr)
      return err(c, `Failed to fetch summaries: ${sumErr.message}`, 500);

    const summaryIds = summaries?.map((s: { id: string }) => s.id) || [];

    if (summaryIds.length === 0)
      return err(
        c,
        "No active summaries found for this topic. Upload content first.",
        404,
      );

    // 5b: Get keywords for those summaries
    const { data: keywords, error: kwErr } = await db
      .from("keywords")
      .select("id, name, definition, summary_id")
      .in("summary_id", summaryIds)
      .is("deleted_at", null);

    if (kwErr)
      return err(c, `Failed to fetch keywords: ${kwErr.message}`, 500);

    if (!keywords || keywords.length === 0)
      return err(
        c,
        "No keywords found for this topic. Generate keywords first.",
        404,
      );

    const keywordIds = keywords.map(
      (k: { id: string }) => k.id,
    ) as string[];

    // 5c+5d: Parallelize connections + subtopics (both depend only on keywordIds)
    // M4 FIX: For large ID sets (>100), split or() queries into chunks and merge results
    const OR_CHUNK_SIZE = 100;

    async function fetchConnectionsChunked(ids: string[]) {
      if (ids.length <= OR_CHUNK_SIZE) {
        const idList = ids.join(",");
        return db.from("keyword_connections")
          .select("keyword_a_id, keyword_b_id, connection_type")
          .or(`keyword_a_id.in.(${idList}),keyword_b_id.in.(${idList})`)
          .is("deleted_at", null);
      }
      // Split into chunks and merge
      const allData: Array<{ keyword_a_id: string; keyword_b_id: string; connection_type: string }> = [];
      for (let i = 0; i < ids.length; i += OR_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + OR_CHUNK_SIZE);
        const chunkList = chunk.join(",");
        const { data, error } = await db.from("keyword_connections")
          .select("keyword_a_id, keyword_b_id, connection_type")
          .or(`keyword_a_id.in.(${chunkList}),keyword_b_id.in.(${chunkList})`)
          .is("deleted_at", null);
        if (error) return { data: null, error };
        if (data) allData.push(...data);
      }
      // Deduplicate by composite key (a_id + b_id)
      const seen = new Set<string>();
      const deduped = allData.filter((c) => {
        const key = `${c.keyword_a_id}|${c.keyword_b_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { data: deduped, error: null };
    }

    // NEW FIX: Wrap Promise.all in try/catch for network-level error safety
    let connectionsResult, subtopicsResult;
    try {
      [connectionsResult, subtopicsResult] = await Promise.all([
        fetchConnectionsChunked(keywordIds),
        db.from("subtopics")
          .select("id, keyword_id")
          .in("keyword_id", keywordIds)
          .is("deleted_at", null),
      ]);
    } catch (e) {
      console.error("[analyze-graph] Parallel DB fetch failed:", e);
      return err(c, `Failed to fetch graph data: ${(e as Error).message}`, 500);
    }

    const { data: connections, error: connErr } = connectionsResult;
    if (connErr)
      return err(
        c,
        `Failed to fetch connections: ${connErr.message}`,
        500,
      );

    const { data: subtopics, error: stErr } = subtopicsResult;
    if (stErr)
      return err(c, `Failed to fetch subtopics: ${stErr.message}`, 500);

    const subtopicIds =
      subtopics?.map((s: { id: string }) => s.id) || [];

    // Build subtopic -> keyword mapping
    const subtopicToKeyword: Record<string, string> = {};
    for (const st of subtopics || []) {
      subtopicToKeyword[st.id] = st.keyword_id;
    }

    // Fetch BKT states for this student
    let bktStates: Array<{
      subtopic_id: string;
      p_know: number;
      total_attempts: number;
      correct_attempts: number;
      last_attempt_at: string | null;
    }> = [];

    if (subtopicIds.length > 0) {
      const { data: bktData, error: bktErr } = await db
        .from("bkt_states")
        .select(
          "subtopic_id, p_know, total_attempts, correct_attempts, last_attempt_at",
        )
        .eq("student_id", user.id)
        .in("subtopic_id", subtopicIds);

      if (bktErr)
        return err(
          c,
          `Failed to fetch BKT states: ${bktErr.message}`,
          500,
        );

      bktStates = bktData || [];
    }

    // ── Step 6: Map BKT states back to keywords ────────────────
    const kwMasterySum: Record<string, number> = {};
    const kwMasteryCount: Record<string, number> = {};
    for (const bkt of bktStates) {
      const kwId = subtopicToKeyword[bkt.subtopic_id];
      if (kwId) {
        kwMasterySum[kwId] = (kwMasterySum[kwId] || 0) + bkt.p_know;
        kwMasteryCount[kwId] = (kwMasteryCount[kwId] || 0) + 1;
      }
    }
    const keywordMastery: Record<string, number> = {};
    for (const kwId of Object.keys(kwMasterySum)) {
      keywordMastery[kwId] = kwMasterySum[kwId] / kwMasteryCount[kwId];
    }

    // ── Step 7: Build prompt with graph data ───────────────────
    // M3 FIX: Only send full definitions for weak keywords (mastery < 0.5).
    // For keywords with BKT data and mastery >= 0.5, send only name + mastery
    // to reduce token waste in the Claude prompt.
    const keywordData = keywords.map(
      (kw: { id: string; name: string; definition: string }) => {
        const mastery = keywordMastery[kw.id] ?? null;
        const isStrong = mastery !== null && mastery >= 0.5;
        return {
          id: kw.id,
          name: kw.name,
          ...(isStrong ? {} : { definition: sanitizeForPrompt(kw.definition || "", 500) }),
          mastery,
        };
      },
    );

    // L4 FIX: Removed redundant `relationship` field — only send connection_type,
    // keyword_a_id, keyword_b_id to Claude to reduce token waste.
    const connectionData = (connections || []).map(
      (conn: {
        keyword_a_id: string;
        keyword_b_id: string;
        connection_type: string;
      }) => ({
        from: conn.keyword_a_id,
        to: conn.keyword_b_id,
        type: conn.connection_type,
      }),
    );

    const prompt = [
      "Analyze this student's knowledge graph and provide recommendations.",
      "",
      wrapXml("keywords", JSON.stringify(keywordData)),
      "",
      wrapXml("connections", JSON.stringify(connectionData)),
      "",
      `Total keywords: ${keywords.length}`,
      `Keywords with mastery data: ${Object.keys(keywordMastery).length}`,
      `Existing connections: ${connectionData.length}`,
    ].join("\n");

    // ── Step 8: Call Claude ─────────────────────────────────────
    let result;
    try {
      result = await generateText({
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        temperature: 0.7,
        maxTokens: 2048,
      });
    } catch (e) {
      console.error(
        `[analyze-graph] Claude generation failed: ${(e as Error).message}`,
      );
      return err(c, "AI analysis failed. Please try again later.", 502);
    }

    // ── Step 9: Parse response ─────────────────────────────────
    let parsed;
    try {
      parsed = parseClaudeJson<{
        weak_areas: Array<{
          keyword_id: string;
          keyword_name: string;
          mastery: number;
          recommendation: string;
        }>;
        strong_areas: Array<{
          keyword_id: string;
          keyword_name: string;
          mastery: number;
        }>;
        missing_connections: Array<{
          from_keyword: string;
          to_keyword: string;
          suggested_type: string;
          reason: string;
        }>;
        study_path: Array<{
          step: number;
          action: string;
          keyword_id: string;
          reason: string;
        }>;
        overall_score: number;
        summary_text: string;
      }>(result.text);
    } catch (e) {
      console.error(
        `[analyze-graph] Failed to parse Claude JSON: ${(e as Error).message}`,
      );
      return err(c, "AI returned invalid response. Please try again.", 502);
    }

    // ── Step 10: Validate and enrich response ─────────────────
    // Clamp overall_score to [0, 1]
    parsed.overall_score = Math.max(0, Math.min(1, parsed.overall_score || 0));

    // Clamp mastery values in weak/strong areas
    for (const wa of parsed.weak_areas) wa.mastery = Math.max(0, Math.min(1, wa.mastery || 0));
    for (const sa of parsed.strong_areas) sa.mastery = Math.max(0, Math.min(1, sa.mastery || 0));

    // Enrich study_path with keyword_name from fetched keywords
    const kwNameMap = new Map(keywords.map((k: { id: string; name: string }) => [k.id, k.name]));

    // Filter out AI-hallucinated keyword_ids not in our actual keyword set
    parsed.weak_areas = (parsed.weak_areas || []).filter((wa) => kwNameMap.has(wa.keyword_id));
    parsed.strong_areas = (parsed.strong_areas || []).filter((sa) => kwNameMap.has(sa.keyword_id));

    // Validate study_path actions and keyword_ids
    const VALID_ACTIONS = new Set(["review", "quiz", "flashcard"]);
    parsed.study_path = (parsed.study_path || []).filter(
      (s) => kwNameMap.has(s.keyword_id) && VALID_ACTIONS.has(s.action),
    );

    // missing_connections: Claude returns keyword *names* (not IDs), so check
    // against a name set. Also accept IDs for robustness.
    const kwNameSet = new Set(kwNameMap.values());
    const kwIdSet = new Set(kwNameMap.keys());
    parsed.missing_connections = (parsed.missing_connections || []).filter(
      (mc) =>
        (kwNameSet.has(mc.from_keyword) || kwIdSet.has(mc.from_keyword)) &&
        (kwNameSet.has(mc.to_keyword) || kwIdSet.has(mc.to_keyword)),
    );

    const enrichedStudyPath = parsed.study_path.map((step) => ({
      ...step,
      keyword_name: kwNameMap.get(step.keyword_id) || step.keyword_id,
    }));

    return ok(
      c,
      {
        ...parsed,
        study_path: enrichedStudyPath,
        _meta: {
          model: GENERATE_MODEL,
          tokens: result.tokensUsed,
          keyword_count: keywords.length,
          connection_count: connectionData.length,
        },
      },
      200,
    );
  },
);
