/**
 * routes/ai/suggest-connections.ts — Suggest new keyword connections
 *
 * POST /ai/suggest-student-connections
 *   Body: { topic_id, existing_node_ids, existing_edge_ids }
 *
 * Returns 3-8 suggested connections between keywords in the student's
 * knowledge graph that don't already exist, ranked by confidence.
 *
 * Security:
 *   - Authenticated users only (any role)
 *   - Institution resolved from topic via RPC
 *
 * Pattern: PF-05 — all DB queries execute BEFORE the AI call.
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
import { generateText, parseClaudeJson } from "../../claude-ai.ts";
import { sanitizeForPrompt, wrapXml } from "../../prompt-sanitize.ts";
import { resolveInstitutionViaRpc } from "../../lib/institution-resolver.ts";

export const aiSuggestConnectionsRoutes = new Hono();

// ── Constants ────────────────────────────────────────────────────
const MAX_NODE_IDS = 200;

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

const SYSTEM_PROMPT = `You are an AI tutor for medical education. Given a student's knowledge graph (keywords + existing connections), suggest new connections they should make.

Respond with a JSON array of suggested connections:
[
  {
    "source": "keyword_uuid",
    "target": "keyword_uuid",
    "type": "one of: prerequisito, causa-efecto, mecanismo, dx-diferencial, tratamiento, manifestacion, regulacion, contraste, componente, asociacion",
    "reason": "Brief explanation in Spanish of why this connection matters",
    "confidence": 0.0-1.0
  }
]

Rules:
- Only suggest connections between keywords in the provided list
- Do NOT suggest connections that already exist
- Suggest 3-8 connections, sorted by confidence descending
- Each source/target must be a valid UUID from the keyword list
- Reasons should be educational and in Spanish
- Focus on medically meaningful relationships`;

// ── POST /ai/suggest-student-connections ─────────────────────────

aiSuggestConnectionsRoutes.post(
  `${PREFIX}/ai/suggest-student-connections`,
  async (c: Context) => {
    // ── 1. Auth + parse body ──────────────────────────────────
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const body = await safeJson(c);
    if (!body) return err(c, "Invalid JSON body", 400);

    // ── 2. Validate inputs ────────────────────────────────────
    const { topic_id, existing_node_ids, existing_edge_ids } = body as {
      topic_id?: string;
      existing_node_ids?: string[];
      existing_edge_ids?: string[];
    };

    if (!isUuid(topic_id))
      return err(c, "topic_id is required (valid UUID)", 400);

    if (!Array.isArray(existing_node_ids) || existing_node_ids.length === 0)
      return err(c, "existing_node_ids must be a non-empty array of UUIDs", 400);

    if (existing_node_ids.length > MAX_NODE_IDS)
      return err(c, `existing_node_ids cannot exceed ${MAX_NODE_IDS} items`, 400);

    for (const nid of existing_node_ids) {
      if (!isUuid(nid))
        return err(c, `Invalid UUID in existing_node_ids: ${nid}`, 400);
    }

    if (!Array.isArray(existing_edge_ids))
      return err(c, "existing_edge_ids must be an array of strings", 400);

    // ── 3. Resolve institution from topic ─────────────────────
    const instId = await resolveInstitutionViaRpc(db, "topics", topic_id);
    if (!instId)
      return err(c, "Could not resolve institution from topic", 404);

    // ── 4. Role check — any role ──────────────────────────────
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      instId,
      ALL_ROLES as unknown as string[],
    );
    if (isDenied(roleCheck))
      return err(c, roleCheck.message, roleCheck.status);

    // ── 5. PF-05: ALL DB queries BEFORE AI call ───────────────

    // 5a. Fetch keywords for topic (through summaries)
    const { data: summaries, error: sumErr } = await db
      .from("summaries")
      .select("id")
      .eq("topic_id", topic_id)
      .eq("is_active", true)
      .is("deleted_at", null);

    if (sumErr)
      return err(c, `Failed to fetch summaries: ${sumErr.message}`, 500);

    const summaryIds = (summaries || []).map(
      (s: { id: string }) => s.id,
    );

    if (summaryIds.length === 0)
      return err(c, "No active summaries found for this topic", 404);

    const { data: keywords, error: kwErr } = await db
      .from("keywords")
      .select("id, name, definition")
      .in("summary_id", summaryIds);

    if (kwErr)
      return err(c, `Failed to fetch keywords: ${kwErr.message}`, 500);

    if (!keywords || keywords.length === 0)
      return err(c, "No keywords found for this topic", 404);

    // 5b. Fetch existing connections among these nodes
    const nodeIds = existing_node_ids;
    const idList = nodeIds.join(",");

    const { data: existingConns, error: connErr } = await db
      .from("keyword_connections")
      .select("keyword_a_id, keyword_b_id, connection_type")
      .or(`keyword_a_id.in.(${idList}),keyword_b_id.in.(${idList})`);

    if (connErr)
      return err(c, `Failed to fetch connections: ${connErr.message}`, 500);

    // ── 6. Build prompt ───────────────────────────────────────
    const validKeywordIds = new Set(keywords.map((k: { id: string }) => k.id));

    const keywordBlock = keywords
      .map(
        (k: { id: string; name: string; definition: string | null }) =>
          `- ${k.id} | ${sanitizeForPrompt(k.name, 200)} | ${sanitizeForPrompt(k.definition || "Sin definicion", 500)}`,
      )
      .join("\n");

    const connBlock = (existingConns || [])
      .map(
        (c: {
          keyword_a_id: string;
          keyword_b_id: string;
          connection_type: string;
        }) => `- ${c.keyword_a_id} -> ${c.keyword_b_id} (${c.connection_type})`,
      )
      .join("\n");

    const prompt = [
      wrapXml("keywords", keywordBlock),
      wrapXml(
        "existing_connections",
        connBlock || "No existing connections yet.",
      ),
      "Based on these keywords and existing connections, suggest 3-8 NEW connections the student should make. Return ONLY a JSON array.",
    ].join("\n\n");

    // ── 7. Call Claude ────────────────────────────────────────
    let result: { text: string };
    try {
      result = await generateText({
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        temperature: 0.8,
        maxTokens: 1500,
      });
    } catch (e) {
      console.error(`[suggest-connections] Claude error: ${(e as Error).message}`);
      return err(c, "AI analysis failed. Please try again later.", 502);
    }

    // ── 8. Parse + validate response ──────────────────────────
    let suggestions: Array<{
      source: string;
      target: string;
      type: string;
      reason: string;
      confidence: number;
    }>;

    try {
      suggestions = parseClaudeJson<typeof suggestions>(result.text);
    } catch {
      return err(c, "AI returned invalid JSON", 502);
    }

    if (!Array.isArray(suggestions))
      return err(c, "AI returned unexpected format", 502);

    // Filter to only valid keyword IDs and known connection types
    const connectionTypeSet = new Set<string>(CONNECTION_TYPES);

    const filtered = suggestions.filter(
      (s) =>
        validKeywordIds.has(s.source) &&
        validKeywordIds.has(s.target) &&
        s.source !== s.target &&
        connectionTypeSet.has(s.type) &&
        typeof s.reason === "string" &&
        typeof s.confidence === "number" &&
        s.confidence >= 0 &&
        s.confidence <= 1,
    );

    // Sort by confidence descending
    filtered.sort((a, b) => b.confidence - a.confidence);

    // ── 9. Return ─────────────────────────────────────────────
    return ok(c, filtered);
  },
);
