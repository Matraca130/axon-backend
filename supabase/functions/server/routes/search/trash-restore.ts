/**
 * routes/search/trash-restore.ts — Trash & Restore endpoints
 *
 * GET  /trash            — List soft-deleted items across tables
 * POST /restore/:table/:id — Restore a soft-deleted item
 *
 * N-2 FIX: Trash queries run in parallel via Promise.all.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";

export const trashRestoreRoutes = new Hono();

const RESTORE_WHITELIST: Record<string, string> = {
  summaries: "summaries", keywords: "keywords", flashcards: "flashcards",
  "quiz-questions": "quiz_questions", videos: "videos",
};

const RESTORE_ROLES = ["owner", "admin", "professor"];

const TABLE_MAP: Record<string, { table: string; titleField: string }> = {
  summaries: { table: "summaries", titleField: "title" },
  keywords: { table: "keywords", titleField: "name" },
  flashcards: { table: "flashcards", titleField: "front" },
  "quiz-questions": { table: "quiz_questions", titleField: "question_text" },
  videos: { table: "videos", titleField: "title" },
};

trashRestoreRoutes.get(`${PREFIX}/trash`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const type = c.req.query("type");
  const targets = type && TABLE_MAP[type]
    ? [{ key: type, ...TABLE_MAP[type] }]
    : Object.entries(TABLE_MAP).map(([key, v]) => ({ key, ...v }));

  try {
    const queryResults = await Promise.all(
      targets.map((target) =>
        db.from(target.table)
          .select(`id, ${target.titleField}, deleted_at`)
          .not("deleted_at", "is", null)
          .order("deleted_at", { ascending: false })
          .limit(50)
      ),
    );

    const items: { id: string; type: string; title: string; deleted_at: string }[] = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      for (const item of queryResults[i].data || []) {
        items.push({ id: item.id, type: target.key, title: item[target.titleField] || item.id, deleted_at: item.deleted_at });
      }
    }
    items.sort((a, b) => new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime());
    return ok(c, { items: items.slice(0, 50) });
  } catch (e: any) {
    return err(c, `Trash error: ${e.message}`, 500);
  }
});

trashRestoreRoutes.post(`${PREFIX}/restore/:table/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const tableParam = c.req.param("table");
  const id = c.req.param("id");
  const realTable = RESTORE_WHITELIST[tableParam];
  if (!realTable) return err(c, `Table '${tableParam}' not allowed. Allowed: ${Object.keys(RESTORE_WHITELIST).join(", ")}`, 400);

  const { data: membership } = await db.from("memberships").select("role").eq("user_id", user.id).single();
  if (!membership || !RESTORE_ROLES.includes(membership.role)) return err(c, "Insufficient permissions to restore items", 403);

  try {
    const { data, error } = await db.from(realTable)
      .update({ deleted_at: null }).eq("id", id).not("deleted_at", "is", null)
      .select().single();
    if (error) return err(c, error.message, 400);
    if (!data) return err(c, "Item not found or already active", 404);
    return ok(c, { restored: true, item: data });
  } catch (e: any) {
    return err(c, `Restore error: ${e.message}`, 500);
  }
});
