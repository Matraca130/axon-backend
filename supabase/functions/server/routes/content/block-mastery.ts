/**
 * block-mastery.ts — GET /server/summaries/:id/block-mastery
 *
 * Returns mastery level (0–1) per summary block based on BKT p_know values.
 *
 * Algorithm (3 DB queries max):
 *   Q1: Fetch active summary_blocks (id, type, content)
 *   Q2: Fetch keywords (name) + their subtopics (id) for the summary
 *   Q3: Fetch bkt_states (p_know) for all relevant subtopics for the student
 *
 * Client-side computation:
 *   - Regex-scan each block's content fields for {{keyword_name}} markers
 *   - Map keywords → subtopics → AVG(p_know) = block mastery
 *   - Blocks without keywords or without BKT data → mastery = -1
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { requireInstitutionRole, isDenied, ALL_ROLES } from "../../auth-helpers.ts";
import { extractKeywordsFromBlock } from "../../lib/block-keywords.ts";
import type { Context } from "npm:hono";

/**
 * GET /server/summaries/:id/block-mastery
 *
 * Returns a map of block_id → mastery (0–1, or -1 if no data).
 * Uses the authenticated user's BKT states (RLS-safe, no admin client).
 */
blockMasteryRoutes.get(
  `${PREFIX}/summaries/:id/block-mastery`,
  async (c: Context) => {
    // ── 1. Auth ──────────────────────────────────────────────
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const summaryId = c.req.param("id");
    if (!summaryId) return err(c, "Missing summary ID", 400);

    // ── Institution membership check ────────────────────────
    const { data: summary, error: summaryErr } = await db
      .from("summaries")
      .select("institution_id")
      .eq("id", summaryId)
      .single();

    if (summaryErr || !summary) return err(c, "Summary not found", 404);

    const roleCheck = await requireInstitutionRole(
      db, user.id, summary.institution_id, ALL_ROLES,
    );
    if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

    // ── Q1: Fetch active blocks ─────────────────────────────
    const { data: blocks, error: blocksErr } = await db
      .from("summary_blocks")
      .select("id, type, content")
      .eq("summary_id", summaryId)
      .eq("is_active", true);

    if (blocksErr) return safeErr(c, "Fetch blocks", blocksErr);
    if (!blocks || blocks.length === 0) return ok(c, {});

    // ── Client-side: extract keywords per block ─────────────
    // Map<block_id, keyword_name[]> (lowercased for matching)
    const blockKeywords = new Map<string, string[]>();
    const allKeywordNamesSet = new Set<string>();

    for (const block of blocks) {
      const keywords = extractKeywordsFromBlock(block);
      const lowered = keywords.map((k) => k.toLowerCase());
      blockKeywords.set(block.id, lowered);
      for (const kw of lowered) {
        allKeywordNamesSet.add(kw);
      }
    }

    // If no blocks have keywords, all mastery = -1
    if (allKeywordNamesSet.size === 0) {
      const result: Record<string, number> = {};
      for (const block of blocks) {
        result[block.id] = -1;
      }
      return ok(c, result);
    }

    // ── Q2: Fetch keywords + their subtopic IDs ─────────────
    // Join keywords → subtopics for this summary
    const { data: keywordsData, error: kwErr } = await db
      .from("keywords")
      .select("id, name, subtopics(id)")
      .eq("summary_id", summaryId)
      .eq("is_active", true);

    if (kwErr) return safeErr(c, "Fetch keywords", kwErr);

    // Build Map<keyword_name_lowercase, subtopic_id[]>
    const kwToSubtopics = new Map<string, string[]>();
    const allSubtopicIds: string[] = [];

    if (keywordsData) {
      for (const kw of keywordsData) {
        const name = (kw.name as string).toLowerCase();
        const subtopics = (kw.subtopics as { id: string }[]) || [];
        const stIds = subtopics.map((st) => st.id);
        kwToSubtopics.set(name, stIds);
        allSubtopicIds.push(...stIds);
      }
    }

    // ── Q3: Fetch BKT states for all subtopics ──────────────
    // Uses authenticated user client (RLS) — only returns this student's data
    const subtopicPKnow = new Map<string, number>();

    if (allSubtopicIds.length > 0) {
      const { data: bktData, error: bktErr } = await db
        .from("bkt_states")
        .select("subtopic_id, p_know")
        .in("subtopic_id", allSubtopicIds)
        .eq("student_id", user.id);

      if (bktErr) return safeErr(c, "Fetch BKT states", bktErr);

      if (bktData) {
        for (const state of bktData) {
          subtopicPKnow.set(state.subtopic_id, state.p_know);
        }
      }
    }

    // ── Calculate mastery per block ─────────────────────────
    const result: Record<string, number> = {};

    for (const block of blocks) {
      const kwNames = blockKeywords.get(block.id) || [];

      // No keywords → mastery -1
      if (kwNames.length === 0) {
        result[block.id] = -1;
        continue;
      }

      // Collect all p_know values for this block's keywords' subtopics
      const pKnowValues: number[] = [];

      for (const kwName of kwNames) {
        const stIds = kwToSubtopics.get(kwName) || [];
        for (const stId of stIds) {
          const pk = subtopicPKnow.get(stId);
          if (pk !== undefined) {
            pKnowValues.push(pk);
          }
        }
      }

      // No BKT data for any subtopic → mastery -1
      if (pKnowValues.length === 0) {
        result[block.id] = -1;
        continue;
      }

      // AVG(p_know) = block mastery
      const avg =
        pKnowValues.reduce((sum, v) => sum + v, 0) / pKnowValues.length;
      // Round to 4 decimal places for clean JSON
      result[block.id] = Math.round(avg * 10000) / 10000;
    }

    return ok(c, result);
  },
);
