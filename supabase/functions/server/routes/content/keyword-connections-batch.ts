/**
 * routes/content/keyword-connections-batch.ts — Batch keyword connections
 *
 * EC-02 FIX: Eliminates the N+1 pattern where the frontend had to:
 *   1. GET /keywords?summary_id=xxx                         → N keywords
 *   2. GET /keyword-connections?keyword_id=yyy × N           → connections each
 *   Total: 1 + N HTTP requests per Keywords tab open (up to 25+)
 *
 * New pattern:
 *   1. GET /keyword-connections-batch?keyword_ids=id1,id2    → ALL connections
 *   Total: 1 HTTP request per Keywords tab open
 *
 * HOW IT WORKS:
 *   Accepts comma-separated keyword UUIDs, queries keyword_connections
 *   with .or(keyword_a_id.in.(...), keyword_b_id.in.(...)).
 *   PostgreSQL optimizes this with index scans.
 *   Frontend groups results by keyword_id client-side.
 *
 * JOINS:
 *   F1/F2-A: Includes embedded keyword objects (id, name, summary_id,
 *   definition) on both sides. Eliminates frontend fallback fetches
 *   for external keyword resolution.
 *
 * STUDENT FILTER (F3):
 *   Students only see connections where BOTH keywords belong to
 *   published summaries. Same logic as keyword-connections.ts LIST.
 *
 * SECURITY:
 *   - Authenticated (same as all Axon endpoints)
 *   - Institution membership verified via first keyword
 *   - F3 student filter for draft-summary protection
 *   - Max 50 keyword_ids per request (prevents abuse)
 *
 * RESPONSE FORMAT:
 *   { data: [{ id, keyword_a_id, keyword_b_id, keyword_a: {...}, keyword_b: {...}, ... }, ...] }
 *   Flat array — frontend groups by keyword_id and extracts counts.
 *
 * FILE: supabase/functions/server/routes/content/keyword-connections-batch.ts
 * REPO: Matraca130/axon-backend
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";

export const kwConnectionsBatchRoutes = new Hono();

// ─── Constants ────────────────────────────────────────────────────

const MAX_KEYWORD_IDS = 50;

// F1/F2-A: Join keyword names + summary_id + definition on both sides
const CONNECTION_SELECT = [
  "id",
  "keyword_a_id",
  "keyword_b_id",
  "relationship",
  "connection_type",
  "source_keyword_id",
  "created_at",
  "keyword_a:keywords!keyword_a_id(id, name, summary_id, definition)",
  "keyword_b:keywords!keyword_b_id(id, name, summary_id, definition)",
].join(", ");

// ─── Helper: resolve institution from a keyword ──────────────────

async function resolveInstitutionFromKeyword(
  db: any,
  keywordId: string,
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc("resolve_parent_institution", {
      p_table: "keywords",
      p_id: keywordId,
    });
    if (error || !data) return null;
    return data as string;
  } catch {
    return null;
  }
}

// ─── GET /keyword-connections-batch?keyword_ids=uuid1,uuid2,... ──

kwConnectionsBatchRoutes.get(
  `${PREFIX}/keyword-connections-batch`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    // ── Validate keyword_ids ──────────────────────────────────
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

    // ── Verify institution membership via first keyword ───────
    // All keywords in a summary belong to the same institution.
    // Checking the first one is sufficient for authorization.
    const institutionId = await resolveInstitutionFromKeyword(db, ids[0]);
    if (!institutionId) {
      return err(c, "Keyword not found or not accessible", 404);
    }
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      institutionId,
      ALL_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }

    // ── Query connections for all keyword_ids at once ─────────
    // Uses .or() with .in() on both sides (bidirectional match).
    // PostgREST translates this to:
    //   WHERE keyword_a_id IN (...) OR keyword_b_id IN (...)
    // PostgreSQL optimizes this with index scans on both columns.
    const idList = ids.join(",");
    const { data, error } = await db
      .from("keyword_connections")
      .select(CONNECTION_SELECT)
      .or(`keyword_a_id.in.(${idList}),keyword_b_id.in.(${idList})`)
      .order("created_at", { ascending: true })
      .limit(500);

    if (error) {
      return err(
        c,
        `Batch keyword-connections failed: ${error.message}`,
        500,
      );
    }

    // ── F3: Student filter — only published summaries on both sides
    if (roleCheck.role === "student") {
      const summaryIds = new Set<string>();
      for (const conn of (data as any[])) {
        if (conn.keyword_a?.summary_id) summaryIds.add(conn.keyword_a.summary_id);
        if (conn.keyword_b?.summary_id) summaryIds.add(conn.keyword_b.summary_id);
      }

      if (summaryIds.size === 0) return ok(c, data ?? []);

      // Single indexed query to check published status (~2-3ms)
      const { data: pubSummaries } = await db
        .from("summaries")
        .select("id")
        .in("id", [...summaryIds])
        .eq("status", "published")
        .eq("is_active", true)
        .is("deleted_at", null);

      const pubIds = new Set((pubSummaries || []).map((s: any) => s.id));

      // Keep only connections where BOTH sides are published
      const filtered = (data as any[]).filter((conn: any) => {
        const aPub = conn.keyword_a?.summary_id
          ? pubIds.has(conn.keyword_a.summary_id)
          : false;
        const bPub = conn.keyword_b?.summary_id
          ? pubIds.has(conn.keyword_b.summary_id)
          : false;
        return aPub && bPub;
      });

      return ok(c, filtered);
    }

    return ok(c, data ?? []);
  },
);
