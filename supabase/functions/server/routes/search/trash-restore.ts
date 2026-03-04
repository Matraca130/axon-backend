/**
 * routes/search/trash-restore.ts — Trash & Restore endpoints
 *
 * GET  /trash            — List soft-deleted items (institution-scoped)
 * POST /restore/:table/:id — Restore a soft-deleted item
 *
 * H-4 FIX:
 *   - GET /trash now calls trash_scoped() RPC which scopes to caller's
 *     institutions via auth.uid(). Replaces unscoped global queries.
 *   - POST /restore now resolves the item's institution via
 *     resolve_summary_institution() RPC, then verifies caller has
 *     CONTENT_WRITE_ROLES in that institution.
 *   - Fixes the ambiguous .single() on memberships (was only filtering
 *     by user_id without institution scoping).
 *
 * Previous fix preserved:
 *   N-2: Parallel trash queries (now single RPC call, even better)
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";

export const trashRestoreRoutes = new Hono();

// ─── Constants ────────────────────────────────────────────────────

const RESTORE_WHITELIST: Record<string, string> = {
  summaries: "summaries",
  keywords: "keywords",
  flashcards: "flashcards",
  "quiz-questions": "quiz_questions",
  videos: "videos",
};

const VALID_TRASH_TYPES = ["all", ...Object.keys(RESTORE_WHITELIST)];

// ── GET /trash ─────────────────────────────────────────────────────
// H-4 FIX: Calls trash_scoped() RPC which uses auth.uid() to scope
// deleted items to the caller's accessible institutions.
trashRestoreRoutes.get(`${PREFIX}/trash`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const type = c.req.query("type") || "all";
  if (!VALID_TRASH_TYPES.includes(type)) {
    return err(c, `Invalid type. Allowed: ${VALID_TRASH_TYPES.join(", ")}`, 400);
  }

  try {
    const { data, error } = await db.rpc("trash_scoped", {
      p_type: type,
      p_limit: 50,
    });

    if (error) return err(c, `Trash error: ${error.message}`, 500);

    const items = (data ?? []).map(
      (row: { result_type: string; result_id: string; title: string; deleted_at: string }) => ({
        id: row.result_id,
        type: row.result_type,
        title: row.title || row.result_id,
        deleted_at: row.deleted_at,
      }),
    );

    return ok(c, { items });
  } catch (e: any) {
    return err(c, `Trash error: ${e.message}`, 500);
  }
});

// ── POST /restore/:table/:id ─────────────────────────────────────
// H-4 FIX:
//   1. Resolve the item's summary_id (or the item IS a summary)
//   2. Call resolve_summary_institution() RPC to get institution_id
//   3. requireInstitutionRole with CONTENT_WRITE_ROLES
//   4. Proceed with restore
//
// This replaces the broken .single() on memberships that only
// filtered by user_id (ambiguous with multiple memberships).
trashRestoreRoutes.post(`${PREFIX}/restore/:table/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const tableParam = c.req.param("table");
  const id = c.req.param("id");
  const realTable = RESTORE_WHITELIST[tableParam];
  if (!realTable) {
    return err(
      c,
      `Table '${tableParam}' not allowed. Allowed: ${Object.keys(RESTORE_WHITELIST).join(", ")}`,
      400,
    );
  }

  try {
    // Step 1: Resolve the item's summary_id
    let summaryId: string | null = null;

    if (realTable === "summaries") {
      // The item IS a summary
      summaryId = id;
    } else {
      // keywords, flashcards, quiz_questions, videos all have summary_id
      const { data: item, error: itemErr } = await db
        .from(realTable)
        .select("summary_id")
        .eq("id", id)
        .single();

      if (itemErr || !item) return err(c, "Item not found", 404);
      summaryId = item.summary_id;
    }

    if (!summaryId) return err(c, "Cannot resolve item's institution (missing summary link)", 400);

    // Step 2: Resolve institution via SQL helper
    const { data: institutionId, error: resolveErr } = await db.rpc(
      "resolve_summary_institution",
      { p_summary_id: summaryId },
    );

    if (resolveErr || !institutionId) {
      return err(c, "Cannot resolve item's institution", 404);
    }

    // Step 3: Verify caller has content-write role in that institution
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      institutionId as string,
      CONTENT_WRITE_ROLES,
    );
    if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

    // Step 4: Proceed with restore
    const { data, error } = await db
      .from(realTable)
      .update({ deleted_at: null })
      .eq("id", id)
      .not("deleted_at", "is", null)
      .select()
      .single();

    if (error) return err(c, error.message, 400);
    if (!data) return err(c, "Item not found or already active", 404);
    return ok(c, { restored: true, item: data });
  } catch (e: any) {
    return err(c, `Restore error: ${e.message}`, 500);
  }
});
