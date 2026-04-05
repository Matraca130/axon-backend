/**
 * block-mastery.ts — GET /server/summaries/:id/block-mastery
 *
 * Returns mastery level (0–1) per summary block from block_mastery_states.
 *
 * Algorithm (2 DB queries):
 *   Q1: Fetch active summary_block IDs for the summary
 *   Q2: Fetch block_mastery_states (p_know) for all blocks for the student
 *
 * Blocks without a block_mastery_states row → mastery = -1 (no data).
 * This is independent from keyword-based BKT — uses the per-block mastery
 * updated by POST /block-review after block quizzes.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { requireInstitutionRole, isDenied, ALL_ROLES } from "../../auth-helpers.ts";
import type { Context } from "npm:hono";

export const blockMasteryRoutes = new Hono();

/**
 * GET /server/summaries/:id/block-mastery
 *
 * Returns a map of block_id → mastery (0–1, or -1 if no data).
 * Uses the authenticated user's block_mastery_states (RLS-safe).
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

    // ── Q1: Fetch active block IDs ──────────────────────────
    const { data: blocks, error: blocksErr } = await db
      .from("summary_blocks")
      .select("id")
      .eq("summary_id", summaryId)
      .eq("is_active", true);

    if (blocksErr) return safeErr(c, "Fetch blocks", blocksErr);
    if (!blocks || blocks.length === 0) return ok(c, {});

    const blockIds = blocks.map((b: { id: string }) => b.id);

    // ── Q2: Fetch block mastery states ──────────────────────
    const { data: masteryData, error: masteryErr } = await db
      .from("block_mastery_states")
      .select("block_id, p_know")
      .eq("student_id", user.id)
      .in("block_id", blockIds);

    if (masteryErr) return safeErr(c, "Fetch block mastery", masteryErr);

    // Build lookup from fetched data
    const masteryMap = new Map<string, number>();
    if (masteryData) {
      for (const row of masteryData) {
        masteryMap.set(row.block_id, row.p_know);
      }
    }

    // ── Build result: blocks with data → p_know, without → -1
    const result: Record<string, number> = {};
    for (const blockId of blockIds) {
      result[blockId] = masteryMap.get(blockId) ?? -1;
    }

    return ok(c, result);
  },
);
