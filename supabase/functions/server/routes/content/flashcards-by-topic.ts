/**
 * routes/content/flashcards-by-topic.ts — Batch flashcard loading by topic
 *
 * PERF C1: Eliminates the N+1 pattern where the frontend had to:
 *   1. GET /summaries?topic_id=xxx           → N summaries
 *   2. GET /flashcards?summary_id=yyy × N    → M flashcards each
 *   Total: 1 + N HTTP requests per topic
 *
 * New pattern:
 *   1. GET /flashcards-by-topic?topic_id=xxx → ALL flashcards for the topic
 *   Total: 1 HTTP request per topic
 *
 * HOW IT WORKS:
 *   The server joins flashcards ← summaries WHERE summaries.topic_id = :topic_id.
 *   This is safe because:
 *     - summaries always belong to exactly one topic (FK constraint)
 *     - flashcards always belong to exactly one summary (FK constraint)
 *     - The join is on indexed columns (summary_id, topic_id)
 *
 * WHY NOT MODIFY THE EXISTING /flashcards ENDPOINT:
 *   The existing endpoint uses crud-factory.ts with parentKey: "summary_id".
 *   Modifying the factory to support an alternative parentKey would:
 *     1. Add complexity to the generic factory (breaks single-responsibility)
 *     2. Risk breaking other tables using the same factory
 *     3. Require changes to the factory's institution scoping logic
 *   A dedicated endpoint is simpler, safer, and self-documenting.
 *
 * WHY NOT USE THE study-queue ENDPOINT:
 *   study-queue returns cards sorted by NeedScore for spaced repetition.
 *   This endpoint returns cards grouped by topic for browsing/deck view.
 *   Different use cases, different sort orders, different response shapes.
 *
 * SECURITY:
 *   - Authenticated (same as all Axon endpoints)
 *   - Filters: deleted_at IS NULL, is_active = true, status = 'published'
 *   - No institution scoping needed here because the frontend already
 *     only knows about topics from its own content-tree (which IS scoped)
 *
 * PAGINATION:
 *   - ?limit=500 (default, max 500)
 *   - ?offset=0
 *   - Most topics have <200 flashcards, so default 500 covers 99% of cases
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";
import { resolveInstitutionViaRpc } from "../../lib/institution-resolver.ts";

export const flashcardsByTopicRoutes = new Hono();

// ─── Constants ────────────────────────────────────────────────────

const MAX_PAGINATION_LIMIT = 500;
const DEFAULT_PAGINATION_LIMIT = 500; // Topics rarely have >200 cards

// ─── GET /flashcards-by-topic?topic_id=xxx ────────────────────────

flashcardsByTopicRoutes.get(
  `${PREFIX}/flashcards-by-topic`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    // ── Validate topic_id ──
    const topicId = c.req.query("topic_id");
    if (!isUuid(topicId)) {
      return err(c, "topic_id must be a valid UUID", 400);
    }

    // ── Defense-in-depth: resolve institution + verify membership ──
    const institutionId = await resolveInstitutionViaRpc(db, "topics", topicId);
    if (!institutionId) {
      return err(c, "Topic not found or not linked to an institution", 404);
    }
    const roleCheck = await requireInstitutionRole(
      db, user.id, institutionId, ALL_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }

    // ── Parse pagination ──
    let limit = parseInt(c.req.query("limit") ?? String(DEFAULT_PAGINATION_LIMIT), 10);
    if (isNaN(limit) || limit < 1) limit = DEFAULT_PAGINATION_LIMIT;
    if (limit > MAX_PAGINATION_LIMIT) limit = MAX_PAGINATION_LIMIT;

    let offset = parseInt(c.req.query("offset") ?? "0", 10);
    if (isNaN(offset) || offset < 0) offset = 0;

    try {
      // ── Step 1: Get published summary IDs for this topic ──
      // WHY a two-step approach instead of a raw SQL join?
      //   Supabase JS client doesn't support cross-table JOINs natively.
      //   We could use an RPC, but two indexed queries are fast enough
      //   (~2-5ms each) and avoid the need for a SQL migration.
      //   The total round-trip is still 1 HTTP request from the frontend.
      const { data: summaries, error: sumErr } = await db
        .from("summaries")
        .select("id")
        .eq("topic_id", topicId)
        .eq("status", "published")
        .eq("is_active", true)
        .is("deleted_at", null);

      if (sumErr) {
        return safeErr(c, "Fetch summaries", sumErr);
      }

      if (!summaries || summaries.length === 0) {
        return ok(c, { items: [], total: 0, limit, offset });
      }

      const summaryIds = summaries.map((s: { id: string }) => s.id);

      // ── Step 2: Get all active flashcards for those summaries ──
      // WHY .in() instead of individual queries?
      //   .in() generates a single SQL WHERE ... IN (...) clause.
      //   PostgreSQL optimizes this into an index scan on summary_id.
      //   This is O(1) queries regardless of how many summaries exist.
      const { data: flashcards, count, error: fcErr } = await db
        .from("flashcards")
        .select(
          "id, summary_id, keyword_id, subtopic_id, front, back, front_image_url, back_image_url, source, is_active, created_at",
          { count: "estimated" },
        )
        .in("summary_id", summaryIds)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .range(offset, offset + limit - 1);

      if (fcErr) {
        return safeErr(c, "Fetch flashcards", fcErr);
      }

      return ok(c, {
        items: flashcards ?? [],
        total: count ?? (flashcards?.length ?? 0),
        limit,
        offset,
      });
    } catch (e) {
      console.error("[flashcards-by-topic] Unexpected error:", e);
      return err(c, "Internal error fetching flashcards", 500);
    }
  },
);
