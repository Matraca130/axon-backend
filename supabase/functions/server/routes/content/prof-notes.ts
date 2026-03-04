/**
 * routes/content/prof-notes.ts — Professor notes on keywords
 *
 * LIST, GET, CREATE/UPSERT, DELETE for kw_prof_notes table.
 * One note per professor per keyword (UNIQUE constraint → upsert).
 *
 * H-5 FIX: All endpoints now verify caller has membership in the
 * keyword's institution via resolve_parent_institution RPC.
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX } from "../../db.ts";
import {
  requireInstitutionRole,
  isDenied,
  ALL_ROLES,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";

export const profNotesRoutes = new Hono();

const profNotesBase = `${PREFIX}/kw-prof-notes`;

/**
 * H-5 helper: resolve institution_id from a keyword or prof-note ID.
 */
async function resolveInstitution(
  db: any,
  table: string,
  id: string,
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc("resolve_parent_institution", {
      p_table: table,
      p_id: id,
    });
    if (error || !data) return null;
    return data as string;
  } catch {
    return null;
  }
}

// LIST — notes for a keyword (all professors' notes visible)
profNotesRoutes.get(profNotesBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const keywordId = c.req.query("keyword_id");
  if (!keywordId)
    return err(c, "Missing required query param: keyword_id", 400);

  // H-5 FIX: Verify caller is a member of the keyword's institution
  const institutionId = await resolveInstitution(db, "keywords", keywordId);
  if (!institutionId) return err(c, "Keyword not found", 404);
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

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
  const { user, db } = auth;

  const id = c.req.param("id");

  // H-5 FIX: Verify caller is a member of the note's institution
  const institutionId = await resolveInstitution(db, "kw_prof_notes", id);
  if (!institutionId) return err(c, "Note not found", 404);
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

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

  // H-5 FIX: Verify caller has write access in the keyword's institution
  const institutionId = await resolveInstitution(db, "keywords", keyword_id);
  if (!institutionId) return err(c, "Keyword not found", 404);
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, CONTENT_WRITE_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

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
  const { user, db } = auth;

  const id = c.req.param("id");

  // H-5 FIX: Verify caller has write access in the note's institution
  const institutionId = await resolveInstitution(db, "kw_prof_notes", id);
  if (!institutionId) return err(c, "Note not found", 404);
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, CONTENT_WRITE_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { error } = await db.from("kw_prof_notes").delete().eq("id", id);
  if (error)
    return err(
      c,
      `Delete kw_prof_note ${id} failed: ${error.message}`,
      500,
    );
  return ok(c, { deleted: id });
});
