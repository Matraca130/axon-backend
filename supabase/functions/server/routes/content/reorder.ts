/**
 * routes/content/reorder.ts — Bulk reorder endpoint
 *
 * PUT /reorder  body: { table: "courses", items: [{ id, order_index }] }
 *
 * M-3 FIX: Uses bulk_reorder() DB function (single query) with graceful
 * fallback to N individual UPDATE queries if the function doesn't exist.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import type { Context } from "npm:hono";

export const reorderRoutes = new Hono();

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Run async tasks in batches to avoid overwhelming the connection pool.
 */
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

// ─── Configuration ────────────────────────────────────────────────────

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

// Tables that have updated_at (only needed for fallback path)
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

// ─── Endpoint ─────────────────────────────────────────────────────────

reorderRoutes.put(`${PREFIX}/reorder`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

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

  // Validate every item's shape and types upfront
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

  // ── Primary path: single DB function call (M-3) ──
  const { data: rpcData, error: rpcError } = await db.rpc("bulk_reorder", {
    p_table: table,
    p_items: typedItems,
  });

  if (!rpcError) {
    const reordered = rpcData?.reordered ?? typedItems.length;
    return ok(c, { reordered, method: "rpc" });
  }

  // ── Fallback: N individual queries (if DB function not yet deployed) ──
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
