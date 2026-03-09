/**
 * routes/content/flashcard-mappings.ts — Lightweight flashcard→topic mapping
 *
 * BUG P0 FIX: useTopicMastery needs flashcard_id → subtopic_id mapping
 * for FSRS per-topic aggregation. The existing /flashcards endpoint
 * requires summary_id (crud-factory parentKey), but useTopicMastery
 * needs ALL flashcards across ALL topics.
 *
 * This endpoint returns ONLY { id, subtopic_id, keyword_id } — no card
 * content (front/back/images). This is ~10x lighter than full flashcard
 * objects and perfect for building lookup maps.
 *
 * WHY A SEPARATE ENDPOINT:
 *   1. /flashcards requires summary_id (crud-factory parentKey)
 *   2. /flashcards-by-topic requires topic_id (one topic at a time)
 *   3. useTopicMastery needs ALL published flashcards at once
 *   4. Only 3 columns needed (id, subtopic_id, keyword_id)
 *
 * SECURITY:
 *   - Authenticated (same as all Axon endpoints)
 *   - W7-SEC04 FIX: Scoped to user's active institution memberships.
 *     Previously returned ALL flashcards across all institutions.
 *     Now filters via summaries.institution_id JOIN.
 *   - Filters: is_active = true, deleted_at IS NULL
 *   - Optional status filter (default: all non-deleted)
 *
 * PAGINATION:
 *   - ?limit=500 (default, max 1000)
 *   - ?offset=0
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import type { Context } from "npm:hono";

export const flashcardMappingRoutes = new Hono();

// ─── Constants ────────────────────────────────────────────────────

const MAX_PAGINATION_LIMIT = 1000;
const DEFAULT_PAGINATION_LIMIT = 500;

// ─── GET /flashcard-mappings?status=published&limit=500&offset=0 ──

flashcardMappingRoutes.get(
  `${PREFIX}/flashcard-mappings`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    // ── Parse query params ──
    const status = c.req.query("status"); // optional: 'published', 'draft', etc.

    let limit = parseInt(c.req.query("limit") ?? String(DEFAULT_PAGINATION_LIMIT), 10);
    if (isNaN(limit) || limit < 1) limit = DEFAULT_PAGINATION_LIMIT;
    if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;

    let offset = parseInt(c.req.query("offset") ?? "0", 10);
    if (isNaN(offset) || offset < 0) offset = 0;

    try {
      // ── W7-SEC04 FIX: Scope to user's active institutions ──
      // Get the user's active institution memberships
      const { data: memberships, error: memErr } = await db
        .from("memberships")
        .select("institution_id")
        .eq("user_id", user.id)
        .eq("is_active", true);

      if (memErr) {
        return err(c, `Failed to resolve memberships: ${memErr.message}`, 500);
      }

      // No active memberships → no flashcards accessible
      if (!memberships || memberships.length === 0) {
        return ok(c, { data: [], total: 0, limit, offset });
      }

      const institutionIds = memberships.map(
        (m: { institution_id: string }) => m.institution_id,
      );

      // ── Build query: only 3 columns, scoped by institution ──
      // Uses !inner JOIN on summaries to filter by institution_id.
      // The summaries columns are NOT returned in the response
      // (PostgREST strips them when not selected in the top-level).
      let query = db
        .from("flashcards")
        .select(
          "id, subtopic_id, keyword_id, summaries!inner(institution_id)",
          { count: "estimated" },
        )
        .in(
          "summaries.institution_id",
          institutionIds,
        )
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .range(offset, offset + limit - 1);

      // Optional status filter
      if (status) {
        query = query.eq("status", status);
      }

      const { data, count, error: queryErr } = await query;

      if (queryErr) {
        return err(c, `Failed to fetch flashcard mappings: ${queryErr.message}`, 500);
      }

      // Strip the joined summaries object from each row —
      // the frontend only needs { id, subtopic_id, keyword_id }
      const cleaned = (data ?? []).map(
        (row: Record<string, unknown>) => ({
          id: row.id,
          subtopic_id: row.subtopic_id,
          keyword_id: row.keyword_id,
        }),
      );

      return ok(c, {
        data: cleaned,
        total: count ?? cleaned.length,
        limit,
        offset,
      });
    } catch (e) {
      console.error("[flashcard-mappings] Unexpected error:", e);
      return err(
        c,
        `flashcard-mappings failed: ${(e as Error).message}`,
        500,
      );
    }
  },
);
