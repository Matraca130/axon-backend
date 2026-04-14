/**
 * routes/study/sticky-notes.ts — Per-student sticky note scratchpad
 *
 * Endpoints (all student-scoped via JWT, RLS-protected):
 *   GET  /sticky-notes?summary_id=xxx   — fetch this student's note for a summary
 *   POST /sticky-notes                  — upsert (atomic, conflict on student_id+summary_id)
 *   DELETE /sticky-notes?summary_id=xxx — clear the note for a summary
 *
 * The auto-filter is enforced both by the explicit student_id = user.id filter
 * and by the RLS policy on the table (defense-in-depth).
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import type { Context } from "npm:hono";

export const stickyNotesRoutes = new Hono();

const MAX_CONTENT_LENGTH = 20_000; // ~20 KB safety cap

// ─── GET /sticky-notes?summary_id=xxx ────────────────────────────────

stickyNotesRoutes.get(`${PREFIX}/sticky-notes`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const summaryId = c.req.query("summary_id");
  if (!isUuid(summaryId)) return err(c, "summary_id must be a valid UUID", 400);

  const { data, error } = await db
    .from("sticky_notes")
    .select("*")
    .eq("student_id", user.id)
    .eq("summary_id", summaryId)
    .maybeSingle();

  if (error) return safeErr(c, "Get sticky_note", error);
  return ok(c, data);
});

// ─── POST /sticky-notes ──────────────────────────────────────────────

stickyNotesRoutes.post(`${PREFIX}/sticky-notes`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);
  if (!isUuid(body.summary_id))
    return err(c, "summary_id must be a valid UUID", 400);
  if (typeof body.content !== "string")
    return err(c, "content must be a string", 400);
  if (body.content.length > MAX_CONTENT_LENGTH)
    return err(c, `content exceeds max length (${MAX_CONTENT_LENGTH})`, 400);

  const row = {
    student_id: user.id,
    summary_id: body.summary_id,
    content: body.content,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("sticky_notes")
    .upsert(row, { onConflict: "student_id,summary_id" })
    .select()
    .single();

  if (error) return safeErr(c, "Upsert sticky_note", error);
  return ok(c, data);
});

// ─── DELETE /sticky-notes?summary_id=xxx ─────────────────────────────

stickyNotesRoutes.delete(`${PREFIX}/sticky-notes`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const summaryId = c.req.query("summary_id");
  if (!isUuid(summaryId)) return err(c, "summary_id must be a valid UUID", 400);

  const { error } = await db
    .from("sticky_notes")
    .delete()
    .eq("student_id", user.id)
    .eq("summary_id", summaryId);

  if (error) return safeErr(c, "Delete sticky_note", error);
  return ok(c, { deleted: true, summary_id: summaryId });
});
