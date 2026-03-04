/**
 * routes/content/keyword-connections.ts — Keyword connection endpoints
 *
 * LIST, GET, CREATE, DELETE for keyword_connections table.
 * Enforces canonical order (a < b) on creation.
 * Not a CRUD factory table — uses manual endpoints.
 *
 * U-4 FIX: Safety limit added to LIST endpoint.
 *
 * H-5 FIX: All endpoints now verify caller has membership in the
 * resource's institution via resolve_parent_institution RPC.
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

export const keywordConnectionRoutes = new Hono();

const connBase = `${PREFIX}/keyword-connections`;

/**
 * H-5 helper: resolve institution_id from a keyword_id or connection ID.
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

// LIST — get connections for a keyword (either side)
keywordConnectionRoutes.get(connBase, async (c: Context) => {
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
    .from("keyword_connections")
    .select("*")
    .or(`keyword_a_id.eq.${keywordId},keyword_b_id.eq.${keywordId}`)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error)
    return err(c, `List keyword_connections failed: ${error.message}`, 500);
  return ok(c, data);
});

// GET by ID
keywordConnectionRoutes.get(`${connBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  // H-5 FIX: Verify caller is a member of the connection's institution
  const institutionId = await resolveInstitution(db, "keyword_connections", id);
  if (!institutionId) return err(c, "Connection not found", 404);
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { data, error } = await db
    .from("keyword_connections")
    .select("*")
    .eq("id", id)
    .single();
  if (error)
    return err(
      c,
      `Get keyword_connection ${id} failed: ${error.message}`,
      404,
    );
  return ok(c, data);
});

// CREATE — enforces canonical order (a < b)
keywordConnectionRoutes.post(connBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const keyword_a_id = body.keyword_a_id;
  const keyword_b_id = body.keyword_b_id;
  const relationship = body.relationship;

  if (typeof keyword_a_id !== "string" || typeof keyword_b_id !== "string") {
    return err(c, "keyword_a_id and keyword_b_id must be strings", 400);
  }
  if (keyword_a_id === keyword_b_id) {
    return err(c, "Cannot connect a keyword to itself", 400);
  }

  // H-5 FIX: Verify caller has write access + both keywords are in the same institution
  const instA = await resolveInstitution(db, "keywords", keyword_a_id);
  if (!instA) return err(c, "Keyword A not found", 404);

  const instB = await resolveInstitution(db, "keywords", keyword_b_id);
  if (!instB) return err(c, "Keyword B not found", 404);

  if (instA !== instB) {
    return err(c, "Cannot connect keywords from different institutions", 403);
  }

  const roleCheck = await requireInstitutionRole(db, user.id, instA, CONTENT_WRITE_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  // Enforce canonical order: a < b
  const [a, b] =
    keyword_a_id < keyword_b_id
      ? [keyword_a_id, keyword_b_id]
      : [keyword_b_id, keyword_a_id];

  const { data, error } = await db
    .from("keyword_connections")
    .insert({
      keyword_a_id: a,
      keyword_b_id: b,
      relationship: typeof relationship === "string" ? relationship : null,
    })
    .select()
    .single();

  if (error)
    return err(
      c,
      `Create keyword_connection failed: ${error.message}`,
      500,
    );
  return ok(c, data, 201);
});

// DELETE — hard delete (not sacred)
keywordConnectionRoutes.delete(`${connBase}/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const id = c.req.param("id");

  // H-5 FIX: Verify caller has write access in the connection's institution
  const institutionId = await resolveInstitution(db, "keyword_connections", id);
  if (!institutionId) return err(c, "Connection not found", 404);
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, CONTENT_WRITE_ROLES);
  if (isDenied(roleCheck)) return err(c, roleCheck.message, roleCheck.status);

  const { error } = await db
    .from("keyword_connections")
    .delete()
    .eq("id", id);
  if (error)
    return err(
      c,
      `Delete keyword_connection ${id} failed: ${error.message}`,
      500,
    );
  return ok(c, { deleted: id });
});
