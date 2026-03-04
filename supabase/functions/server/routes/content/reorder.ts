/**
 * routes/content/reorder.ts — Bulk reorder endpoint
 *
 * PUT /reorder  body: { table: "courses", items: [{ id, order_index }] }
 *
 * M-3 FIX: Uses bulk_reorder() DB function (single query) with graceful
 * fallback to N individual UPDATE queries if the function doesn't exist.
 *
 * H-5 FIX: Now verifies caller has CONTENT_WRITE_ROLES in the institution
 * that the first item belongs to.
 *
 * A-10 FIX: Only checks institution for tables supported by the
 * resolve_parent_institution RPC. Tables outside the content hierarchy
 * (e.g. study_plan_tasks) proceed without institution check.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";

export const reorderRoutes = new Hono();

// ─── Helpers ────────────────────────────────────────────────────

async function parallelBatch<T>(
  tasks: (() => Promise<T>)[],
  batchSize = 20,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
  }
  return results;
}

// ─── Configuration ──────────────────────────────────────────────

const MAX_REORDER_ITEMS = 200;

const allowedReorderTables = [
  "courses",
  "semesters",
  "sections",
  "topics",
  "summaries",
  "chunks",
  "summary_blocks",
  "subtopics",
  "videos",
  "models_3d",
  "model_3d_pins",
  "study_plan_tasks",
];

const tablesWithUpdatedAt = new Set([
  "courses",
  "semesters",
  "sections",
  "topics",
  "summaries",
  "videos",
  "models_3d",
  "model_3d_pins",
]);

// A-10 FIX: Tables that the resolve_parent_institution() RPC can resolve.
// Only these tables get institution-scoped checks in reorder.
// Tables NOT in this set (e.g. study_plan_tasks) proceed without
// institution check — they're protected by other means (user-scoped parents).
const INSTITUTION_RESOLVABLE_TABLES = new Set([
  "courses",
  "semesters",
  "sections",
  "topics",
  "summaries",
  "chunks",
  "summary_blocks",
  "subtopics",
  "keywords",
  "keyword_connections",
  "kw_prof_notes",
  "videos",
  "models_3d",
  "model_3d_pins",
]);

// ─── Endpoint ───────────────────────────────────────────────────

reorderRoutes.put(`${PREFIX}/reorder`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const table = body.table;
  const items = body.items;

  if (typeof table !== "string" || !allowedReorderTables.includes(table)) {
    return err(c, `Reorder not allowed for table: ${table}`, 400);
  }

  if (!Array.isArray(items) || items.length === 0) {
    return err(
      c,
      "items must be a non-empty array of { id, order_index }",
      400,
    );
  }

  if (items.length > MAX_REORDER_ITEMS) {
    return err(
      c,
      `Too many items: ${items.length} (max ${MAX_REORDER_ITEMS})`,
      400,
    );
  }

  const invalid = items.filter((i: unknown) => {
    if (!i || typeof i !== "object") return true;
    const item = i as Record<string, unknown>;
    return (
      typeof item.id !== "string" ||
      typeof item.order_index !== "number" ||
      !Number.isFinite(item.order_index)
    );
  });
  if (invalid.length > 0) {
    return err(
      c,
      `Invalid items (each needs id:string, order_index:number): ${JSON.stringify(invalid)}`,
      400,
    );
  }

  const typedItems = items as Array<{ id: string; order_index: number }>;

  // H-5 + A-10 FIX: Only check institution for tables the RPC supports.
  // Tables like study_plan_tasks are not in the content hierarchy and
  // their parents are user-scoped — checking would fail with 404.
  if (INSTITUTION_RESOLVABLE_TABLES.has(table)) {
    try {
      const { data: institutionId, error: resolveErr } = await db.rpc(
        "resolve_parent_institution",
        { p_table: table, p_id: typedItems[0].id },
      );

      if (resolveErr || !institutionId) {
        return err(c, "Cannot resolve institution for reorder items", 404);
      }

      const roleCheck = await requireInstitutionRole(
        db,
        user.id,
        institutionId as string,
        CONTENT_WRITE_ROLES,
      );
      if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);
    } catch {
      return err(c, "Institution resolution failed", 500);
    }
  }
  // else: table not in content hierarchy (e.g. study_plan_tasks)
  // → skip institution check, proceed with reorder

  // ── Primary path: single DB function call (M-3) ──
  const { data: rpcData, error: rpcError } = await db.rpc("bulk_reorder", {
    p_table: table,
    p_items: typedItems,
  });

  if (!rpcError) {
    const reordered = rpcData?.reordered ?? typedItems.length;
    return ok(c, { reordered, method: "rpc" });
  }

  // ── Fallback: N individual queries ──
  console.warn(
    `[reorder] bulk_reorder RPC failed, falling back to N queries: ${rpcError.message}`,
  );

  const hasUpdatedAt = tablesWithUpdatedAt.has(table);
  const now = new Date().toISOString();

  const tasks = typedItems.map((item) => () => {
    const patch: Record<string, unknown> = { order_index: item.order_index };
    if (hasUpdatedAt) patch.updated_at = now;
    return db.from(table).update(patch).eq("id", item.id);
  });

  const results = await parallelBatch(tasks, 20);
  const errors = results
    .filter((r: { error: unknown }) => r.error)
    .map((r: { error: { message: string } }) => r.error.message);

  if (errors.length > 0) {
    return err(
      c,
      `Reorder partial failure (${errors.length}/${typedItems.length}): ${errors.join("; ")}`,
      500,
    );
  }

  return ok(c, { reordered: typedItems.length, method: "fallback" });
});
