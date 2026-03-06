/**
 * routes/content/subtopics-batch.ts — Batch subtopics by keyword IDs
 *
 * H-1 FIX: Eliminates the N+1 pattern where the frontend had to:
 *   1. GET /keywords?summary_id=xxx              → N keywords
 *   2. GET /subtopics?keyword_id=yyy × N          → M subtopics each
 *   Total: 1 + N HTTP requests per summary
 *
 * New pattern:
 *   1. GET /subtopics-batch?keyword_ids=id1,id2   → ALL subtopics
 *   Total: 1 HTTP request per summary
 *
 * HOW IT WORKS:
 *   Accepts comma-separated keyword UUIDs, queries subtopics table
 *   with .in("keyword_id", ids). PostgreSQL optimizes this into an
 *   index scan. Frontend groups results by keyword_id client-side.
 *
 * WHY NOT MODIFY THE EXISTING /subtopics ENDPOINT:
 *   The existing endpoint uses crud-factory.ts with parentKey: "keyword_id".
 *   Modifying the factory to support .in() queries would:
 *     1. Add complexity to the generic factory (breaks single-responsibility)
 *     2. Risk breaking other 8 tables using the same factory
 *     3. Require changes to the factory's pagination + count logic
 *   A dedicated endpoint is simpler, safer, and self-documenting.
 *   (Same rationale as flashcards-by-topic.ts — see lines 26-30 there.)
 *
 * SECURITY:
 *   - Authenticated (same as all Axon endpoints)
 *   - RLS on subtopics table handles institution scoping
 *   - Filters: deleted_at IS NULL (soft-delete aware)
 *   - Max 50 keyword_ids per request (prevents abuse)
 *
 * RESPONSE FORMAT:
 *   { data: [{ id, keyword_id, name, order_index, ... }, ...] }
 *   Flat array (not grouped) — frontend groups by keyword_id.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import type { Context } from "npm:hono";

export const subtopicsBatchRoutes = new Hono();

// ─── Constants ────────────────────────────────────────────────────

const MAX_KEYWORD_IDS = 50;

// ─── GET /subtopics-batch?keyword_ids=uuid1,uuid2,... ────────────

subtopicsBatchRoutes.get(
  `${PREFIX}/subtopics-batch`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { db } = auth;

    // ── Validate keyword_ids ──
    const raw = c.req.query("keyword_ids");
    if (!raw) {
      return err(c, "Missing required query param: keyword_ids", 400);
    }

    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      return err(c, "keyword_ids must contain at least one UUID", 400);
    }
    if (ids.length > MAX_KEYWORD_IDS) {
      return err(
        c,
        `keyword_ids cannot exceed ${MAX_KEYWORD_IDS} (got ${ids.length})`,
        400,
      );
    }
    for (const id of ids) {
      if (!isUuid(id)) {
        return err(c, `Invalid UUID in keyword_ids: ${id}`, 400);
      }
    }

    // ── Query subtopics for all keyword_ids at once ──
    // Uses .in() → single SQL WHERE keyword_id IN (...) clause.
    // PostgreSQL optimizes this into an index scan on keyword_id.
    // Ordered by order_index for consistent frontend rendering.
    const { data, error } = await db
      .from("subtopics")
      .select("*")
      .in("keyword_id", ids)
      .is("deleted_at", null)
      .order("order_index", { ascending: true });

    if (error) {
      return err(c, `Batch subtopics failed: ${error.message}`, 500);
    }

    return ok(c, data ?? []);
  },
);
