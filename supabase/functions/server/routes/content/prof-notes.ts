/**
 * routes/content/prof-notes.ts — Professor notes on keywords
 *
 * LIST, GET, CREATE/UPSERT, DELETE for kw_prof_notes table.
 * One note per professor per keyword (UNIQUE constraint → upsert).
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import type { Context } from "npm:hono";

export const profNotesRoutes = new Hono();

const profNotesBase = `${PREFIX}/kw-prof-notes`;

// LIST — notes for a keyword (all professors' notes visible)
profNotesRoutes.get(profNotesBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const keywordId = c.req.query("keyword_id");
  if (!keywordId)
    return err(c, "Missing required query param: keyword_id", 400);

  const { data, error } = await db
    .from("kw_prof_notes")
    .select("*")
    .eq("keyword_id", keywordId)
    .order("created_at", { ascending: true });

  if (error)
    return err(c, `List kw_prof_notes failed: ${error.message}`, 500);
  return ok(c, data);
});

// GET by ID
profNotesRoutes.get(`${profNotesBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { data, error } = await db
    .from("kw_prof_notes")
    .select("*")
    .eq("id", id)
    .single();
  if (error)
    return err(c, `Get kw_prof_note ${id} failed: ${error.message}`, 404);
  return ok(c, data);
});

// CREATE / UPSERT — one note per professor per keyword (UNIQUE constraint)
profNotesRoutes.post(profNotesBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const keyword_id = body.keyword_id;
  const note = body.note;

  if (typeof keyword_id !== "string" || typeof note !== "string") {
    return err(c, "keyword_id and note must be non-empty strings", 400);
  }

  const { data, error } = await db
    .from("kw_prof_notes")
    .upsert(
      {
        professor_id: user.id,
        keyword_id,
        note,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "professor_id,keyword_id" },
    )
    .select()
    .single();

  if (error)
    return err(c, `Upsert kw_prof_note failed: ${error.message}`, 500);
  return ok(c, data, 201);
});

// DELETE
profNotesRoutes.delete(`${profNotesBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { db } = auth;

  const id = c.req.param("id");
  const { error } = await db.from("kw_prof_notes").delete().eq("id", id);
  if (error)
    return err(
      c,
      `Delete kw_prof_note ${id} failed: ${error.message}`,
      500,
    );
  return ok(c, { deleted: id });
});
