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
 *
 * V2: POST now accepts connection_type and source_keyword_id.
 *     connection_type is validated against a whitelist of 10
 *     predefined medical relationship types.
 *     source_keyword_id indicates direction for directional types.
 *
 * F1 FIX: LIST and GET now join keyword names via PostgREST embedded
 *     resources, eliminating N+1 queries from the frontend.
 *
 * F2-A FIX: Expanded join to include summary_id and definition.
 *     summary_id is required for cross-summary navigation links.
 *     definition is used for tooltip previews in KeywordPopup.
 *     This makes frontend Phases 2 & 3 (fallback fetches) no-ops.
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

// ── V2: Valid connection types (medical education) ───────────
const VALID_CONNECTION_TYPES = new Set([
  "prerequisito",
  "causa-efecto",
  "mecanismo",
  "dx-diferencial",
  "tratamiento",
  "manifestacion",
  "regulacion",
  "contraste",
  "componente",
  "asociacion",
]);

// ── F1 + F2-A: Explicit select with keyword joins ───────────
// F2-A: Added summary_id and definition to eliminate frontend
// fallback fetches (Phases 2 & 3 in useKeywordPopupQueries).
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
// F1 FIX: Now joins keyword names to avoid N+1 on the frontend.
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
    .select(CONNECTION_SELECT)
    .or(`keyword_a_id.eq.${keywordId},keyword_b_id.eq.${keywordId}`)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error)
    return err(c, `List keyword_connections failed: ${error.message}`, 500);
  return ok(c, data);
});

// GET by ID
// F1 FIX: Now includes keyword name joins for consistency with LIST.
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
    .select(CONNECTION_SELECT)
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
// V2: Now accepts connection_type and source_keyword_id.
keywordConnectionRoutes.post(connBase, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const keyword_a_id = body.keyword_a_id;
  const keyword_b_id = body.keyword_b_id;
  const relationship = body.relationship;
  const connection_type = body.connection_type;           // V2
  const source_keyword_id = body.source_keyword_id;       // V2

  if (typeof keyword_a_id !== "string" || typeof keyword_b_id !== "string") {
    return err(c, "keyword_a_id and keyword_b_id must be strings", 400);
  }
  if (keyword_a_id === keyword_b_id) {
    return err(c, "Cannot connect a keyword to itself", 400);
  }

  // V2: Validate connection_type if provided
  if (connection_type != null) {
    if (
      typeof connection_type !== "string" ||
      !VALID_CONNECTION_TYPES.has(connection_type)
    ) {
      return err(
        c,
        `Invalid connection_type. Must be one of: ${[...VALID_CONNECTION_TYPES].join(", ")}`,
        400,
      );
    }
  }

  // V2: Validate source_keyword_id if provided
  if (source_keyword_id != null) {
    if (typeof source_keyword_id !== "string") {
      return err(c, "source_keyword_id must be a string (UUID)", 400);
    }
    if (
      source_keyword_id !== String(keyword_a_id) &&
      source_keyword_id !== String(keyword_b_id)
    ) {
      return err(
        c,
        "source_keyword_id must be either keyword_a_id or keyword_b_id",
        400,
      );
    }
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

  // V2: Build insert payload with optional new fields
  const insertPayload: Record<string, unknown> = {
    keyword_a_id: a,
    keyword_b_id: b,
    relationship: typeof relationship === "string" ? relationship : null,
  };

  if (connection_type != null) {
    insertPayload.connection_type = connection_type;
  }
  if (source_keyword_id != null) {
    insertPayload.source_keyword_id = source_keyword_id;
  }

  const { data, error } = await db
    .from("keyword_connections")
    .insert(insertPayload)
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
